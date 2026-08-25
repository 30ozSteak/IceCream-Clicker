export interface CoverGeometry {
  renderedWidth: number;
  renderedHeight: number;
  offsetX: number;
  offsetY: number;
}

function requirePositiveDimension(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive finite number.`);
  }
}

export function calculateCoverGeometry(
  stageWidth: number,
  stageHeight: number,
  imageWidth: number,
  imageHeight: number,
): CoverGeometry {
  requirePositiveDimension(stageWidth, "Stage width");
  requirePositiveDimension(stageHeight, "Stage height");
  requirePositiveDimension(imageWidth, "Image width");
  requirePositiveDimension(imageHeight, "Image height");

  const scale = Math.max(stageWidth / imageWidth, stageHeight / imageHeight);
  const renderedWidth = imageWidth * scale;
  const renderedHeight = imageHeight * scale;

  return {
    renderedWidth,
    renderedHeight,
    offsetX: (stageWidth - renderedWidth) / 2,
    offsetY: (stageHeight - renderedHeight) / 2,
  };
}

export function normalizedImagePointToStage(
  geometry: CoverGeometry,
  x: number,
  y: number,
): { x: number; y: number } {
  return {
    x: geometry.offsetX + x * geometry.renderedWidth,
    y: geometry.offsetY + y * geometry.renderedHeight,
  };
}

export function stagePointToNormalizedImage(
  geometry: CoverGeometry,
  x: number,
  y: number,
): { x: number; y: number } {
  return {
    x: Math.min(1, Math.max(0, (x - geometry.offsetX) / geometry.renderedWidth)),
    y: Math.min(1, Math.max(0, (y - geometry.offsetY) / geometry.renderedHeight)),
  };
}
