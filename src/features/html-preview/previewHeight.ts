/** The reader's standard height for a page that has not said how tall it is. */
const STANDARD = "min(70vh, 720px)";
/** Height of the toolbar above the page. */
const TOOLBAR_PX = 32;
const MIN_PX = 200;

/**
 * CSS height of an inline preview: fit the page and the toolbar, no shorter than
 * a usable minimum and never taller than the reader's standard height.
 */
export function previewHeightCss(contentPx: number | undefined): string {
  if (contentPx === undefined) return STANDARD;
  return `min(max(${contentPx + TOOLBAR_PX}px, ${MIN_PX}px), ${STANDARD})`;
}
