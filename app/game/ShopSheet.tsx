"use client";

import {
  FEEDERS,
  UNLOCKS,
  nextUnlock,
  type Progress,
  feederCost,
  flavorMultiplier,
  tapPower,
  tapUpgradeCost,
} from "../../lib/economy";
import { formatAmount, formatRate } from "../../lib/number-format";

function ShopRow({
  icon,
  name,
  detail,
  owned,
  cost,
  affordable,
  onBuy,
  highlight = false,
}: {
  icon: string;
  name: string;
  detail: string;
  owned?: number;
  cost: number;
  affordable: boolean;
  onBuy: () => void;
  highlight?: boolean;
}) {
  return (
    <li
      className={`shop-row${affordable ? " shop-row-affordable" : ""}${highlight ? " shop-row-unlock" : ""}`}
    >
      <span className="shop-icon" aria-hidden="true">
        {icon}
      </span>
      <span className="shop-copy">
        <strong>
          {name}
          {owned ? <em>{owned}</em> : null}
        </strong>
        <span>{detail}</span>
      </span>
      <button
        className="shop-buy"
        type="button"
        onClick={onBuy}
        disabled={!affordable}
        aria-label={`Buy ${name} for ${formatAmount(cost)} scoops`}
      >
        {formatAmount(cost)}
      </button>
    </li>
  );
}

export function ShopSheet({
  progress,
  onBuyTapUpgrade,
  onBuyFeeder,
  onBuyUnlock,
  onClose,
}: {
  progress: Progress;
  onBuyTapUpgrade: () => void;
  onBuyFeeder: (index: number) => void;
  onBuyUnlock: () => void;
  onClose: () => void;
}) {
  const multiplier = flavorMultiplier(progress);
  const tapGain =
    (tapPower(progress.tapLevel + 1) - tapPower(progress.tapLevel)) * multiplier;
  const tapCost = tapUpgradeCost(progress.tapLevel);

  // Show what is owned plus the next two tiers, so there is always a goal.
  const highestOwned = progress.feeders.reduce(
    (highest, count, index) => (count > 0 ? index : highest),
    -1,
  );
  const visibleFeeders = FEEDERS.slice(0, Math.min(FEEDERS.length, highestOwned + 3));
  const unlock = nextUnlock(progress);

  return (
    <section className="shop-sheet" id="shop-sheet" aria-label="Shop">
      <header className="shop-header">
        <h2>Shop</h2>
        <button className="shop-close" type="button" onClick={onClose}>
          <span aria-hidden="true">×</span>
          <span className="sr-only">Close shop</span>
        </button>
      </header>
      <div className="shop-scroll">
      {unlock ? (
        <>
          <h3 className="shop-section">
            Unlocks <span>{progress.unlocks} of {UNLOCKS.length}</span>
          </h3>
          <ul className="shop-list">
            <ShopRow
              icon={unlock.icon}
              name={unlock.name}
              detail={unlock.description}
              cost={unlock.cost}
              affordable={progress.scoops >= unlock.cost}
              onBuy={onBuyUnlock}
              highlight
            />
          </ul>
        </>
      ) : null}
      <h3 className="shop-section">Upgrades</h3>
      <ul className="shop-list">
        <ShopRow
          icon="👆"
          name="Bigger Bites"
          detail={`+${formatRate(tapGain)} per tap`}
          owned={progress.tapLevel}
          cost={tapCost}
          affordable={progress.scoops >= tapCost}
          onBuy={onBuyTapUpgrade}
        />
        {visibleFeeders.map((feeder, index) => {
          const cost = feederCost(index, progress.feeders[index]);
          return (
            <ShopRow
              key={feeder.id}
              icon={feeder.icon}
              name={feeder.name}
              detail={`+${formatRate(feeder.rate * multiplier)}/s, feeds while you rest`}
              owned={progress.feeders[index]}
              cost={cost}
              affordable={progress.scoops >= cost}
              onBuy={() => onBuyFeeder(index)}
            />
          );
        })}
      </ul>
      </div>
    </section>
  );
}
