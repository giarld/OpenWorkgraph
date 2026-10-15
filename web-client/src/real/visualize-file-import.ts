import { parseVisualizeAssetPackage, validateVisualizeAssetPackageBytes, VISUALIZE_LIBRARY_MAX_JSON_BYTES, type VisualizeCompatibility } from '../../../packages/protocol/src/visualize-library';
import { errorCode } from './contracts';
import { translate } from '../i18n/translate';

/** A filename is only a hint; validate the complete portable package and bytes. */
export async function readVisualizeImportFile(file: File, compatibility?: VisualizeCompatibility) {
  if (!/[.]owgv$/i.test(file.name)) throw Error(translate('Select an .owgv visualization file.'));
  if (file.size > VISUALIZE_LIBRARY_MAX_JSON_BYTES) throw Error(translate('Interactive content exceeds the size limit.'));
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
    return await validateVisualizeAssetPackageBytes(parseVisualizeAssetPackage(text, compatibility));
  } catch (error) {
    if (errorCode(error) === 'SCHEMA_UNSUPPORTED') throw Error(translate('The visualization file version is unsupported by this Workspace.'));
    if (errorCode(error) === 'PAYLOAD_TOO_LARGE') throw Error(translate('Interactive content exceeds the size limit.'));
    throw Error(translate('The visualization file is invalid or corrupted.'));
  }
}
