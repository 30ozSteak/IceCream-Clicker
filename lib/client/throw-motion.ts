export type ThrowSpin = {
  xTurns: number;
  yTurns: number;
  zTurns: number;
};

export type ThrowPoint = {
  x: number;
  y: number;
  z: number;
};

export const NO_THROW_SPIN: ThrowSpin = {
  xTurns: 0,
  yTurns: 0,
  zTurns: 0,
};

type RandomSource = () => number;

const AXIS_TURNS = 0.65;
const SHORT_Z_TURNS = 0.65;
const LONG_Z_TURNS = 1.3;

export const IDLE_ROTATION_PERIOD_MS = 12_000;
const IDLE_ROTATION_X = -0.18;
const IDLE_ROTATION_Y = 0.52;
const IDLE_ROTATION_Z = -0.08;

function randomDirection(random: RandomSource) {
  return random() < 0.5 ? -1 : 1;
}

export function createThrowSpin(random: RandomSource = Math.random): ThrowSpin {
  return {
    xTurns: random() < 0.55 ? 0 : randomDirection(random) * AXIS_TURNS,
    yTurns: random() < 0.25 ? 0 : randomDirection(random) * AXIS_TURNS,
    zTurns:
      randomDirection(random) *
      (random() < 0.5 ? SHORT_Z_TURNS : LONG_Z_TURNS),
  };
}

export function calculateIdleRotation(
  elapsedMs: number,
  startYaw = IDLE_ROTATION_Y,
): ThrowPoint {
  const normalizedElapsed =
    ((elapsedMs % IDLE_ROTATION_PERIOD_MS) + IDLE_ROTATION_PERIOD_MS) %
    IDLE_ROTATION_PERIOD_MS;
  const progress = normalizedElapsed / IDLE_ROTATION_PERIOD_MS;

  return {
    x: IDLE_ROTATION_X,
    y: startYaw + progress * Math.PI * 2,
    z: IDLE_ROTATION_Z,
  };
}

export function createThrowControlPoint(
  start: ThrowPoint,
  end: ThrowPoint,
  viewportHeight: number,
): ThrowPoint {
  return {
    x: (start.x + end.x) / 2,
    y: Math.max(start.y, end.y) + Math.min(viewportHeight * 0.33, 280),
    z: 34,
  };
}

export function quadraticThrowPoint(
  start: ThrowPoint,
  control: ThrowPoint,
  end: ThrowPoint,
  progress: number,
): ThrowPoint {
  const inverse = 1 - progress;
  return {
    x:
      inverse * inverse * start.x +
      2 * inverse * progress * control.x +
      progress * progress * end.x,
    y:
      inverse * inverse * start.y +
      2 * inverse * progress * control.y +
      progress * progress * end.y,
    z:
      inverse * inverse * start.z +
      2 * inverse * progress * control.z +
      progress * progress * end.z,
  };
}
