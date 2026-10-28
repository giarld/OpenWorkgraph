import { cp } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Vendored official creator, pinned in assets/skill-creator/UPSTREAM.md. */
export async function prepareSkillCreator(inputDirectory: string): Promise<string> {
  const target = join(inputDirectory, 'openworkgraph-skill-creator');
  await cp(fileURLToPath(new URL('../assets/skill-creator/', import.meta.url)), target, { recursive: true, errorOnExist: true, force: false });
  return [
    'OpenWorkgraph built-in skill authoring:',
    'Read ' + JSON.stringify(join(target, 'SKILL.md')) + ' and the linked references before creating or converting the skill. This creator is bundled; do not require installing it.',
    'The user has requested generation, validation and installation in this Workspace. Write the complete package beneath this Run Output directory, preserving licenses, resources and scripts.',
    'After validation, call install_generated_skill with path relative to Output, e.g. {"path":"skills/example-skill"}. This tool validates and atomically installs the complete package; do not write to the managed installation store yourself.',
    'Installation is part of this task. If an existing manual skill conflicts, ask the user before replacing it, then supply its current revision as expectedRevision. Never replace a same-named skill from another source.',
    'Do not claim installation succeeded unless the tool returned success. Fix reported errors and retry; report any unresolved blocker accurately.',
  ].join('\n');
}
