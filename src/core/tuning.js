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
      'As fast as the 4 Lite drivetrain will sustain. Braking distance roughly doubles versus stock; ' +
      'expect noticeably shorter range and a hotter controller.',
    limits: { limitEco: 10, limitDrive: 25, limitSport: 32 },
    requiresAcknowledgement: true,
  },
];

export class Tuner extends Emitter {
  constructor(scooter, { expertMode = false } = {}) {
    super();
    this.scooter = scooter;
    this.expertMode = expertMode;
  }

  get hardCeiling() {
    return this.scooter.profile.limits?.hardCeilingKmh ?? 32;
  }

  /**
   * Check a profile can be applied. Returns a list of blocking problems and a
   * list of things worth warning about; empty blockers means it is safe to run.
   */
  validate(profile) {
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

    if (profile.requiresAcknowledgement) {
      warnings.push(
        'Above the stock limit the brakes, tyres and lights are outside their design envelope, and in most ' +
          'places this makes the scooter road-illegal. Private land only.'
      );
    }
    return { blockers, warnings, ok: blockers.length === 0 };
  }

  /** Apply a profile, stopping at the first write that does not read back. */
  async apply(profile) {
    const { blockers } = this.validate(profile);
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
