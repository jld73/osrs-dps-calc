import {
  IReactionPublic, makeAutoObservable, reaction, toJS,
} from 'mobx';
import React, { createContext, useContext } from 'react';
import { PartialDeep } from 'type-fest';
import * as localforage from 'localforage';
import {
  CalculatedLoadout, Calculator, ImportableData, Preferences, State, UI, UserIssue,
} from '@/types/State';
import merge from 'lodash.mergewith';
import {
  EquipmentPiece, Player, PlayerEquipment, PlayerSkills,
} from '@/types/Player';
import { Monster } from '@/types/Monster';
import { MonsterAttribute } from '@/enums/MonsterAttribute';
import { toast } from 'react-toastify';
import {
  fetchPlayerSkills,
  fetchShortlinkData,
  getCombatStylesForCategory,
  PotionMap,
  WORKER_JSON_REPLACER,
} from '@/utils';
import { RecomputeValuesRequest, WorkerRequestType } from '@/types/WorkerData';
import { scaledMonster } from '@/lib/MonsterScaling';
import getMonsters from '@/lib/Monsters';
import {
  AmmoApplicability,
  ammoApplicability,
  calculateEquipmentBonusesFromGear,
  EquipmentBonuses,
  getCanonicalItemId,
} from '@/lib/Equipment';
import UserIssueType from '@/enums/UserIssueType';
import equipment from '../cdn/json/equipment.json';
import { EquipmentCategory } from './enums/EquipmentCategory';
import {
  ARM_PRAYERS, BRAIN_PRAYERS, DEFENSIVE_PRAYERS, OFFENSIVE_PRAYERS, Prayer,
} from './enums/Prayer';
import Potion from './enums/Potion';

const EMPTY_CALC_LOADOUT = {} as CalculatedLoadout;

const generateInitialEquipment = () => {
  const initialEquipment: PlayerEquipment = {
    ammo: null,
    body: null,
    cape: null,
    feet: null,
    hands: null,
    head: null,
    legs: null,
    neck: null,
    ring: null,
    shield: null,
    weapon: null,
  };
  return initialEquipment;
};

export const generateEmptyPlayer: () => Player = () => ({
  username: '',
  style: getCombatStylesForCategory(EquipmentCategory.NONE)[0],
  skills: {
    atk: 99,
    def: 99,
    hp: 99,
    magic: 99,
    prayer: 99,
    ranged: 99,
    str: 99,
    mining: 99,
  },
  boosts: {
    atk: 0,
    def: 0,
    hp: 0,
    magic: 0,
    prayer: 0,
    ranged: 0,
    str: 0,
    mining: 0,
  },
  equipment: generateInitialEquipment(),
  prayers: [],
  bonuses: {
    str: 0,
    ranged_str: 0,
    magic_str: 0,
    prayer: 0,
  },
  defensive: {
    stab: 0,
    slash: 0,
    crush: 0,
    magic: 0,
    ranged: 0,
  },
  offensive: {
    stab: 0,
    slash: 0,
    crush: 0,
    magic: 0,
    ranged: 0,
  },
  buffs: {
    potions: [],
    onSlayerTask: true,
    inWilderness: false,
    kandarinDiary: false,
    chargeSpell: false,
    markOfDarknessSpell: false,
    forinthrySurge: false,
    soulreaperStacks: 0,
  },
  spell: null,
});

class GlobalState implements State {
  monster: Monster = {
    id: 415,
    name: 'Abyssal demon',
    image: 'Abyssal demon.png',
    size: 1,
    skills: {
      atk: 97,
      def: 135,
      hp: 150,
      magic: 1,
      ranged: 1,
      str: 67,
    },
    offensive: {
      atk: 0,
      magic: 0,
      magic_str: 0,
      ranged: 0,
      ranged_str: 0,
      str: 0,
    },
    defensive: {
      crush: 20,
      magic: 0,
      ranged: 20,
      slash: 20,
      stab: 20,
    },
    isFromCoxCm: false,
    toaInvocationLevel: 0,
    toaPathLevel: 0,
    partyMaxCombatLevel: 126,
    partyAvgMiningLevel: 99,
    partyMaxHpLevel: 99,
    partySize: 1,
    monsterCurrentHp: 150,
    attributes: [MonsterAttribute.DEMON],
    defenceReductions: {
      vulnerability: false,
      accursed: false,
      dwh: 0,
      arclight: 0,
      bgs: 0,
    },
  };

  loadouts: Player[] = [
    generateEmptyPlayer(),
  ];

  selectedLoadout = 0;

  ui: UI = {
    showPreferencesModal: false,
    showShareModal: false,
    username: '',
    issues: [],
  };

  prefs: Preferences = {
    manualMode: false,
    rememberUsername: true,
    showHitDistribution: false,
    showLoadoutComparison: false,
    showTtkComparison: false,
    hitDistsHideZeros: false,
  };

  calc: Calculator = {
    loadouts: [
      {
        npcDefRoll: 0,
        maxHit: 0,
        maxAttackRoll: 0,
        accuracy: 0,
        dps: 0,
        ttk: 0,
        hitDist: [],
        ttkDist: undefined,
      },
    ],
  };

  worker: Worker | null = null;

  workerRecomputeTimer: number | null = null;

  availableEquipment: EquipmentPiece[] = equipment as EquipmentPiece[];

  availableMonsters = getMonsters();

  _debug: boolean = false;

  constructor() {
    makeAutoObservable(this, {}, { autoBind: true });

    const recomputeBoosts = () => {
      // Re-compute the player's boost values.
      const boosts: PlayerSkills = {
        atk: 0, def: 0, hp: 0, magic: 0, prayer: 0, ranged: 0, str: 0, mining: 0,
      };

      for (const p of this.player.buffs.potions) {
        const result = PotionMap[p].calculateFn(this.player.skills);
        for (const k of Object.keys(result)) {
          const r = result[k as keyof typeof result] as number;
          if (r > boosts[k as keyof typeof boosts]) {
            // If this skill's boost is higher than what it already is, then change it
            boosts[k as keyof typeof boosts] = result[k as keyof typeof result] as number;
          }
        }
      }

      this.updatePlayer({ boosts });
    };

    const triggers: ((r: IReactionPublic) => unknown)[] = [
      () => toJS(this.player.skills),
      () => toJS(this.player.buffs.potions),
    ];
    triggers.map((t) => reaction(t, recomputeBoosts, { fireImmediately: false }));
  }

  set debug(debug: boolean) {
    this._debug = debug;
  }

  get debug(): boolean {
    return this._debug;
  }

  /**
   * Get the currently selected player (loadout)
   */
  get player() {
    return this.loadouts[this.selectedLoadout];
  }

  /**
   * Returns the data for the currently equipped items
   */
  get equipmentData() {
    return this.player.equipment;
  }

  /**
   * Get the available combat styles for the currently equipped weapon
   * @see https://oldschool.runescape.wiki/w/Combat_Options
   */
  get availableCombatStyles() {
    const cat = this.player.equipment.weapon?.category || EquipmentCategory.NONE;
    return getCombatStylesForCategory(cat);
  }

  /**
   * Return the player's worn equipment bonuses.
   */
  get equipmentBonuses(): EquipmentBonuses {
    const p = this.player;
    return {
      bonuses: p.bonuses,
      offensive: p.offensive,
      defensive: p.defensive,
    };
  }

  hasUserIssue(type: UserIssueType, loadout: number): UserIssue | false {
    return this.ui.issues.find((t) => t.type === type && t.loadout === loadout) || false;
  }

  recalculateEquipmentBonusesFromGear() {
    const totals = calculateEquipmentBonusesFromGear(this.player, this.monster);
    this.updatePlayer({
      bonuses: totals.bonuses,
      offensive: totals.offensive,
      defensive: totals.defensive,
    });
  }

  updateUIState(ui: PartialDeep<UI>) {
    this.ui = Object.assign(this.ui, ui);
  }

  updateCalculator(calc: PartialDeep<Calculator>) {
    this.calc = Object.assign(this.calc, calc);
  }

  setWorker(worker: Worker | null) {
    this.worker = worker;
  }

  async loadShortlink(linkId: string) {
    let data: ImportableData;
    try {
      data = await fetchShortlinkData(linkId);
    } catch (e) {
      toast.error('Failed to load shared data.', { toastId: 'shortlink-fail' });
      return;
    }

    /**
     * For future reference: if we ever change the schema of the loadouts or the monster object,
     * then some of the JSON data we store for shortlinks will be incorrect. We can handle those instances here, as
     * a sort of "on-demand migration".
     *
     * Also: the reason we're merging the objects below is that we're trying our hardest not to cause the app to
     * error if the JSON data is bad. To achieve that, we do a deep merge of the loadouts and monster objects so that
     * the existing data still remains.
     */

    this.updateImportedData(data);
  }

  updateImportedData(data: ImportableData) {
    this.selectedLoadout = data.selectedLoadout;
    this.loadouts = merge(this.loadouts, data.loadouts);
    this.updateMonster(data.monster);
  }

  loadPreferences() {
    localforage.getItem('dps-calc-prefs').then((v) => {
      this.updatePreferences(v as PartialDeep<Preferences>);
    }).catch((e) => {
      console.error(e);
      // TODO maybe some handling here
    });
  }

  async fetchCurrentPlayerSkills() {
    const { username } = this.ui;

    try {
      const res = await toast.promise(
        fetchPlayerSkills(username),
        {
          pending: 'Fetching player skills...',
          success: `Successfully fetched player skills for ${username}!`,
          error: 'Error fetching player skills',
        },
        {
          toastId: 'skills-fetch',
        },
      );

      if (res) this.updatePlayer({ skills: res });
    } catch (e) {
      console.error(e);
    }
  }

  updatePreferences(pref: PartialDeep<Preferences>) {
    // Update local state store
    this.prefs = Object.assign(this.prefs, pref);

    if (pref && Object.prototype.hasOwnProperty.call(pref, 'manualMode')) {
      // Reset player bonuses to their worn equipment
      this.player.bonuses = this.equipmentBonuses.bonuses;
      this.player.offensive = this.equipmentBonuses.offensive;
      this.player.defensive = this.equipmentBonuses.defensive;
    }

    // Save to browser storage
    localforage.setItem('dps-calc-prefs', toJS(this.prefs)).catch((e) => {
      console.error(e);
      // TODO something that isn't this
      // eslint-disable-next-line no-alert
      alert('Could not persist preferences to browser. Make sure our site has permission to do this.');
    });
  }

  /**
   * Toggle a potion, with logic to remove from or add to the potions array depending on if it is already in there.
   * @param potion
   */
  togglePlayerPotion(potion: Potion) {
    const isToggled = this.player.buffs.potions.includes(potion);
    if (isToggled) {
      this.player.buffs.potions = this.player.buffs.potions.filter((p) => p !== potion);
    } else {
      this.player.buffs.potions = [...this.player.buffs.potions, potion];
    }
  }

  /**
   * Toggle a prayer, with logic to remove from or add to the prayers array depending on if it is already in there.
   * @param prayer
   */
  togglePlayerPrayer(prayer: Prayer) {
    const isToggled = this.player.prayers.includes(prayer);
    if (isToggled) {
      // If we're toggling off an existing prayer, just filter it out from the array
      this.player.prayers = this.player.prayers.filter((p) => p !== prayer);
    } else {
      // If we're toggling on a new prayer, let's do some checks to ensure that some prayers cannot be enabled alongside it
      let newPrayers = [...this.player.prayers];

      // If this is a defensive prayer, disable all other defensive prayers
      if (DEFENSIVE_PRAYERS.includes(prayer)) newPrayers = newPrayers.filter((p) => !DEFENSIVE_PRAYERS.includes(p));

      // If this is an offensive prayer...
      if (OFFENSIVE_PRAYERS.includes(prayer)) {
        newPrayers = newPrayers.filter((p) => {
          // If this is a "brain" prayer, it can only be paired with arm prayers
          if (BRAIN_PRAYERS.includes(prayer)) return !OFFENSIVE_PRAYERS.includes(p) || ARM_PRAYERS.includes(p);
          // If this is an "arm" prayer, it can only be paired with brain prayers
          if (ARM_PRAYERS.includes(prayer)) return !OFFENSIVE_PRAYERS.includes(p) || BRAIN_PRAYERS.includes(p);
          // Otherwise, there are no offensive prayers it can be paired with, disable them all
          return !OFFENSIVE_PRAYERS.includes(p);
        });
      }

      this.player.prayers = [...newPrayers, prayer];
    }
  }

  /**
   * Toggle a monster attribute.
   * @param attr
   */
  toggleMonsterAttribute(attr: MonsterAttribute) {
    const isToggled = this.monster.attributes.includes(attr);
    if (isToggled) {
      this.monster.attributes = this.monster.attributes.filter((a) => a !== attr);
    } else {
      this.monster.attributes = [...this.monster.attributes, attr];
    }
  }

  /**
   * Update the player state.
   * @param player
   */
  updatePlayer(player: PartialDeep<Player>) {
    const eq = player.equipment;
    if (eq && (Object.hasOwn(eq, 'weapon') || Object.hasOwn(eq, 'shield'))) {
      const currentWeapon = this.equipmentData.weapon;
      const newWeapon = player.equipment?.weapon;

      if (newWeapon !== undefined) {
        const oldWeaponCat = currentWeapon?.category || EquipmentCategory.NONE;
        const newWeaponCat = newWeapon?.category || EquipmentCategory.NONE;
        if ((newWeaponCat !== undefined) && (newWeaponCat !== oldWeaponCat)) {
          // If the weapon slot category was changed, we should reset the player's selected combat style to the first one that exists.
          player.style = getCombatStylesForCategory(newWeaponCat)[0];
        }
      }

      const currentShield = this.equipmentData.shield;
      const newShield = player.equipment?.shield;

      // Special handling for if a shield is equipped, and we're using a two-handed weapon
      if (player.equipment?.shield && newShield !== undefined && currentWeapon?.isTwoHanded) {
        player = { ...player, equipment: { ...player.equipment, weapon: null } };
      }
      // ...and vice-versa
      if (player.equipment?.weapon && newWeapon?.isTwoHanded && currentShield?.name !== '') {
        player = { ...player, equipment: { ...player.equipment, shield: null } };
      }
    }

    this.loadouts[this.selectedLoadout] = merge(this.player, player);
    if (eq || Object.hasOwn(player, 'spell')) {
      this.recalculateEquipmentBonusesFromGear();
    }
  }

  /**
   * Update the monster state.
   * @param monster
   */
  updateMonster(monster: PartialDeep<Monster>) {
    this.monster = merge(this.monster, monster, (obj, src) => {
      // This check is to ensure that empty arrays always override existing arrays, even if they have values.
      if (Array.isArray(src) && src.length === 0) {
        return src;
      }
      return undefined;
    });
  }

  /**
   * Clear an equipment slot, removing the item that was inside of it.
   * @param slot
   */
  clearEquipmentSlot(slot: keyof PlayerEquipment) {
    this.updatePlayer({
      equipment: {
        [slot]: null,
      },
    });
  }

  setSelectedLoadout(ix: number) {
    this.selectedLoadout = ix;
  }

  deleteLoadout(ix: number) {
    // Sanity check to ensure we can never have less than one loadout
    if (this.loadouts.length === 1) return;

    this.loadouts = this.loadouts.filter((p, i) => i !== ix);
    // If the selected loadout index is equal to or over the index we just remove, shift it down by one, else add one
    if ((this.selectedLoadout >= ix) && ix !== 0) {
      this.selectedLoadout -= 1;
    }
  }

  get canCreateLoadout() {
    return (this.loadouts.length < 5);
  }

  get canRemoveLoadout() {
    return (this.loadouts.length > 1);
  }

  createLoadout(selected?: boolean, cloneIndex?: number) {
    // Do not allow creating a loadout if we're over the limit
    if (!this.canCreateLoadout) return;

    this.loadouts.push((cloneIndex !== undefined) ? toJS(this.loadouts[cloneIndex]) : generateEmptyPlayer());
    if (selected) this.selectedLoadout = (this.loadouts.length - 1);
  }

  doWorkerRecompute() {
    this.calc.loadouts = this.loadouts.map(() => EMPTY_CALC_LOADOUT);
    if (this.workerRecomputeTimer) {
      window.clearTimeout(this.workerRecomputeTimer);
    }

    this.workerRecomputeTimer = window.setTimeout(() => {
      if (this.worker) {
        const m = this.prefs.manualMode ? this.monster : scaledMonster(this.monster);

        // Before we send our data off to the worker, get canonical versions of equipment as required.
        const loadouts = [...toJS(this.loadouts)];
        for (const l of loadouts) {
          for (const [k, v] of Object.entries(l.equipment)) {
            if (!v) continue;

            const canonicalId = getCanonicalItemId(v.id);
            if (canonicalId !== v.id) {
              // Canonical ID is different to the current EquipmentPiece ID, change EquipmentPiece
              l.equipment[k as keyof PlayerEquipment] = this.availableEquipment.find((eq) => eq.id === canonicalId) || null;
            }
          }
        }

        this.worker.postMessage(JSON.stringify({
          type: WorkerRequestType.RECOMPUTE_VALUES,
          data: {
            loadouts,
            monster: m,
            calcOpts: {
              includeTtkDist: this.prefs.showTtkComparison,
              detailedOutput: this.debug,
            },
          },
        } as RecomputeValuesRequest, WORKER_JSON_REPLACER));
      }
    }, 250);
  }

  doUserIssuesCheck() {
    const issues: UserIssue[] = [];

    // For each loadout, check if there are any issues we should surface to the user.
    for (const [k, l] of Object.entries(this.loadouts)) {
      if (ammoApplicability(l.equipment.weapon?.id, l.equipment.ammo?.id) === AmmoApplicability.INVALID) {
        if (l.equipment.ammo?.name) {
          issues.push({ type: UserIssueType.EQUIPMENT_WRONG_AMMO, loadout: parseInt(k), message: 'This ammo does not work with your current weapon' });
        } else {
          issues.push({ type: UserIssueType.EQUIPMENT_MISSING_AMMO, loadout: parseInt(k), message: 'Your weapon requires ammo to use' });
        }
      }
    }

    this.updateUIState({ issues });
  }
}

const StoreContext = createContext<GlobalState>(new GlobalState());

const StoreProvider: React.FC<{ store: GlobalState, children: React.ReactNode }> = ({ store, children }) => (
  <StoreContext.Provider value={store}>{children}</StoreContext.Provider>
);

const useStore = () => useContext(StoreContext);

export { GlobalState, StoreProvider, useStore };
