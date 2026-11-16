// @nodal-agents/page-render — le moteur de rendu de pages de Nodal (#1082).
//
// `./install` installe et décrit le moteur (le CLI ne charge que lui) ; cet
// index ajoute le rendu, que l'outil `render_pdf` appelle.

export {
  RENDERER_BUILD_ID,
  RENDERER_DIR_ENV,
  RENDERER_INSTALL_COMMAND,
  RendererInstallError,
  installRenderer,
  readRendererStatus,
  recordInstallTurnedOff,
  rendererDir,
  rendererPlatform,
  type InstallRendererOptions,
  type InstallRendererOutcome,
  type RendererStatus,
} from './install';
export {
  MAX_LOCAL_RESOURCE_BYTES,
  MIN_READABLE_SCALE,
  PAGE_ORIGIN,
  PageRenderError,
  RENDER_TIME_LIMIT_MS,
  closeAllRenderers,
  liveRendererPids,
  pathForUrl,
  renderPdf,
  urlForPath,
  type LocalRead,
  type Margins,
  type NotLoaded,
  type PageRenderErrorCode,
  type PaperOptions,
  type RenderPdfRequest,
  type RenderPdfResult,
} from './render';
export { fitToPages, type FitOutcome, type ScaledRender } from './fit';
export {
  PAPER_NAMES,
  PAPER_SIZES_MM,
  paperOf,
  readPdfFacts,
  type PaperFacts,
  type PaperName,
  type PdfFacts,
} from './pdf-facts';
