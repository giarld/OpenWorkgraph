import type { GraphSnapshot, Request } from "./contracts";
import { errorCode } from "./contracts";
import '../i18n/catalogs/real-core';
import { translate } from '../i18n/translate';
interface Page {
  items: GraphSnapshot[];
  nextCursor: string | null;
  snapshotId: string;
  eventCursor: string;
}
/** Never expose accumulated partial pages. A stale cursor restarts the entire list. */
export async function readGraphPages(
  request: Request,
  serviceId: string,
  projectId: string,
  filter: "all" | "trashed",
  assertCurrent: () => void = () => {},
) {
  return retrySnapshot(
    async () =>
      (await readFilter(request, serviceId, projectId, filter, assertCurrent))
        .items,
    assertCurrent,
  );
}

/** Both filters must describe the same event watermark, including empty lists.
 * Deduplication alone cannot detect a restore omitted by both reads. */
export async function readProjectGraphPages(
  request: Request,
  serviceId: string,
  projectId: string,
  assertCurrent: () => void = () => {},
) {
  return retrySnapshot(async () => {
    const active = await readFilter(
      request,
      serviceId,
      projectId,
      "all",
      assertCurrent,
    );
    const trashed = await readFilter(
      request,
      serviceId,
      projectId,
      "trashed",
      assertCurrent,
    );
    assertCurrent();
    if (active.eventCursor !== trashed.eventCursor) throw snapshotChanged();
    const ids = new Set(active.items.map((item) => item.graphId));
    if (trashed.items.some((item) => ids.has(item.graphId)))
      throw snapshotChanged();
    return [...active.items, ...trashed.items];
  }, assertCurrent);
}

function snapshotChanged() {
  return Object.assign(Error(translate("The Work Graph pagination snapshot changed.")), { code: "CURSOR_EXPIRED" });
}

async function retrySnapshot<T>(
  read: () => Promise<T>,
  assertCurrent: () => void,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      assertCurrent();
      const result = await read();
      assertCurrent();
      return result;
    } catch (error) {
      assertCurrent();
      if (errorCode(error) !== "CURSOR_EXPIRED" || attempt >= 3) throw error;
    }
  }
}

// One attempt only: a cross-filter retry must discard BOTH accumulated lists.
async function readFilter(
  request: Request,
  serviceId: string,
  projectId: string,
  filter: "all" | "trashed",
  assertCurrent: () => void,
) {
  const items: GraphSnapshot[] = [],
    seen = new Set<string>(),
    cursors = new Set<string>();
  let cursor: string | null = null,
    snapshot: string | undefined,
    eventCursor: string | undefined;
  do {
    assertCurrent();
    const page: Page = await request(
      `/v1/projects/${encodeURIComponent(projectId)}/graphs/page`,
      { filter, limit: 100, ...(cursor ? { cursor } : {}) },
    );
    assertCurrent();
    if (
      !page ||
      !Array.isArray(page.items) ||
      typeof page.snapshotId !== "string" ||
      !page.snapshotId ||
      typeof page.eventCursor !== "string" ||
      !page.eventCursor ||
      (page.nextCursor !== null && typeof page.nextCursor !== "string")
    )
      throw Error(translate("Invalid Work Graph pagination response."));
    if (
      snapshot !== undefined &&
      (snapshot !== page.snapshotId || eventCursor !== page.eventCursor)
    )
      throw snapshotChanged();
    snapshot = page.snapshotId;
    eventCursor = page.eventCursor;
    for (const item of page.items) {
      if (
        item.serviceId !== serviceId ||
        item.projectId !== projectId ||
        seen.has(item.graphId) ||
        Boolean(item.trashed) !== (filter === "trashed")
      )
        throw Error(translate("The Work Graph pagination scope or identity does not match."));
      seen.add(item.graphId);
      items.push(item);
    }
    cursor = page.nextCursor;
    if (cursor !== null) {
      if (!cursor || cursors.has(cursor)) throw Error(translate("The Work Graph pagination cursor did not advance."));
      cursors.add(cursor);
    }
  } while (cursor !== null);
  return { items, eventCursor };
}
