export type ThrowSpin = {
  xTurns: number;
  yTurns: number;
  zTurns: number;
};

export const NO_THROW_SPIN: ThrowSpin = {
  xTurns: 0,
  yTurns: 0,
  zTurns: 0,
};

type RandomSource = () => number;

function randomDirection(random: RandomSource) {
  return random() < 0.5 ? -1 : 1;
}

export function createThrowSpin(random: RandomSource = Math.random): ThrowSpin {
  return {
    xTurns: random() < 0.55 ? 0 : randomDirection(random),
    yTurns: random() < 0.25 ? 0 : randomDirection(random),
    zTurns: randomDirection(random) * (random() < 0.5 ? 1 : 2),
  };
}
