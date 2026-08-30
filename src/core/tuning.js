// Speed profiles: named sets of register values, applied as one transaction.
//
// Two rules are enforced here rather than in the UI, so they hold no matter how
// the app is driven:
//
//   1. Nothing is written to an address the app has not confirmed on THIS
//      scooter unless expert mode is explicitly on. A wrong address does not
//      raise the limit, it writes garbage into whatever else lives there.
//   2. A profile cannot exceed the model's hard ceiling. The 4 Lite's braking
//      and 8.5in tyres are specced around its 25 km/h stock limit; the ceiling
//      is where this app stops helping, not where the hardware stops.

import { Emitter } from '../util.js';
import { Confidence } from '../proto/registers.js';

export const PROFILES = [
  {
    id: 'stock',
    label: 'Stock (EU)',
    description: 'Factory limits. Use this to put everything back.',
    limits: { limitEco: 6, limitDrive: 20, limitSport: 25 },
  },
  {
    id: 'stock-uk',
    label: 'Stock (UK/Intl 25)',
    description: 'Same 25 km/h cap, with a less restrictive Eco mode.',
    limits: { limitEco: 10, limitDrive: 20, limitSport: 25 },
  },
  {
    id: 'derestricted',
    label: 'Derestricted (30)',
    description: 'Raises Sport to 30 km/h. Private land in most of Europe and the UK.',
    limits: { limitEco: 10, limitDrive: 25, limitSport: 30 },
    requiresAcknowledgement: true,
  },
  {
    id: 'max',
    label: 'Motor limit (32)',
    description:
      'Drive 25, Sport 32 — about as fast as the 4 Lite drivetrain will sustain on the flat. Braking ' +
      'distance roughly doubles versus stock; expect shorter range and a hotter controller.',
    limits: { limitEco: 10, limitDrive: 25, limitSport: 32 },
    requiresAcknowledgement: true,
  },
  {
    id: 'uncapped',
    label: 'Uncapped (40)',
    description:
      'Drive 25, Sport 40. Above ~32 km/h the motor is the limit rather than the setting, so this ' +
      'removes the restriction rather than adding speed.',
    limits: { limitEco: 10, limitDrive: 25, limitSport: 40 },
    requiresAcknowledgement: true,
  },
];

/** Build a one-off profile from limits typed into the per-mode editor. */
export function customProfile(limits) {
  return {
    id: 'custom',
    label: 'Custom limits',
    description: 'Per-mode limits set by hand.',
    limits,
    requiresAcknowledgement: Object.values(limits).some((v) => v > 25),
  };
}

/** The modes the per-mode editor offers, in the order they appear. */
export const MODE_KEYS = ['limitEco', 'limitDrive', 'limitSport'];

const MODE_LABELS = {
  limitEco: 'Eco',
  limitDrive: 'Drive',
  limitSport: 'Sport',
  limitGlobal: 'Global cap',
};

const label = (key) => MODE_LABELS[key] ?? key;

export class Tuner extends Emitter {
  constructor(scooter, { expertMode = false } = {}) {
    super();
    this.scooter = scooter;
    this.expertMode = expertMode;
  }

  get hardCeiling() {
    return this.scooter.profile.limits?.hardCeilingKmh ?? 32;
  }

  /** Above this the app still applies the value, but says plainly what changes. */
  get warnAbove() {
    return this.scooter.profile.limits?.warnAboveKmh ?? 25;
  }

  get stockLimit() {
    return this.scooter.profile.limits?.stockKmh ?? 25;
  }

  /**
   * Check a profile can be applied. Returns a list of blocking problems and a
   * list of things worth warning about; empty blockers means it is safe to run.
   */
  validate(profile, current = null) {
    const blockers = [];
    const warnings = [];

    for (const [key, value] of Object.entries(profile.limits)) {
      const def = this.scooter.registers.find((r) => r.key === key);

      if (!def) {
        blockers.push(`No register mapped for "${key}" on this profile.`);
        continue;
      }
      if (value > this.hardCeiling) {
        blockers.push(`${def.label}: ${value} km/h is above this app's ${this.hardCeiling} km/h ceiling.`);
      }
      if (def.confidence !== Confidence.DERIVED && !this.expertMode) {
        blockers.push(
          `${def.label} sits at address 0x${def.addr.toString(16).toUpperCase()}, which is a ` +
            `${def.confidence} guess carried over from the M365 generation — it has not been confirmed on your ` +
            `scooter. Run Discovery to find the real address, or turn on Expert mode to write it anyway.`
        );
      }
      if (def.confidence === Confidence.CANDIDATE && this.expertMode) {
        warnings.push(`${def.label} is an unconfirmed address. If it reads back wrong, revert immediately.`);
      }
    }

    // Modes are supposed to step upwards. A Drive limit above Sport is more
    // often a typo than an intention, and firmwares differ on how they cope.
    const ordered = ['limitEco', 'limitDrive', 'limitSport'].filter((k) => k in profile.limits);
    for (let i = 1; i < ordered.length; i++) {
      const [lower, higher] = [ordered[i - 1], ordered[i]];
      if (profile.limits[lower] > profile.limits[higher]) {
        warnings.push(
          `${label(lower)} (${profile.limits[lower]}) is set higher than ${label(higher)} ` +
            `(${profile.limits[higher]}). That is allowed, but it means the "faster" mode is the slower one.`
        );
      }
    }

    // A global cap, where the firmware has one, clamps the per-mode limits.
    const globalCap = current?.get?.('limitGlobal');
    const highestMode = Math.max(...ordered.map((k) => profile.limits[k]), 0);
    if (globalCap != null && highestMode > globalCap && !('limitGlobal' in profile.limits)) {
      warnings.push(
        `The global cap is currently ${globalCap} km/h, which is below the ${highestMode} km/h you are setting. ` +
          `On firmwares that honour it, the cap wins and the mode limit will have no effect — raise it too if ` +
          `nothing changes.`
      );
    }

    const overWarn = Object.entries(profile.limits).filter(([, v]) => v > this.warnAbove);
    if (overWarn.length) {
      warnings.push(
        `${overWarn.map(([k, v]) => `${label(k)} ${v} km/h`).join(', ')} — past roughly ${this.warnAbove} km/h ` +
          `the ~300 W motor is the limit rather than the setting, so this removes the restriction rather than ` +
          `adding speed. The controller will run hotter and range will drop noticeably.`
      );
    }

    if (profile.requiresAcknowledgement) {
      warnings.push(
        `Above the ${this.stockLimit} km/h stock limit the brakes, tyres and lights are outside their design ` +
          `envelope — stopping distance grows with the square of speed — and in most places this makes the ` +
          `scooter road-illegal. Private land only.`
      );
    }
    return { blockers, warnings, ok: blockers.length === 0 };
  }

  /** Apply a profile, stopping at the first write that does not read back. */
  async apply(profile, current = null) {
    const { blockers } = this.validate(profile, current);
    if (blockers.length) throw new Error(blockers.join('\n'));

    const applied = [];
    for (const [key, value] of Object.entries(profile.limits)) {
      const def = this.scooter.registers.find((r) => r.key === key);
      this.emit('progress', { key, label: def.label, value });

      const entry = await this.scooter.write(def, value, { reason: `profile:${profile.id}` });
      applied.push(entry);

      if (entry.verified === false) {
        this.emit('aborted', { entry, applied });
        throw new Error(
          `${def.label} did not take the new value (read back ${entry.readBack ?? 'nothing'}). ` +
            `Stopped before writing the rest — use Revert to undo what was applied.`
        );
      }
    }

    this.emit('applied', { profile, applied });
    return applied;
  }

  /** Current speed limits as read from the scooter. */
  async readCurrent() {
    const defs = this.scooter.registersFor('speed');
    return this.scooter.readMany(defs);
  }
}
