/**
 * @name NitroSpoofer
 * @description Client-side Nitro spoof. Premium badge, emoji and stickers anywhere, oversized uploads, profile gradient. Cosmetic only.
 * @author Venice
 * @version 2.0.0
 */

const api = globalThis.revenge ?? globalThis.vendetta;

const TIER_LABEL = { 1: "Nitro Classic", 2: "Nitro", 3: "Nitro Basic" };
const TIER_CYCLE = { 2: 3, 3: 1, 1: 2 };

const FLAG_EARLY_SUPPORTER = 1 << 9;
const FLAG_HYPESQUAD_BRAVERY = 1 << 8;
const UPLOAD_CAP = 500 * 1024 * 1024;
const PREMIUM_SINCE = new Date("2019-02-14T00:00:00.000Z").toISOString();

const DEFAULTS = {
  enabled: true,
  badge: true,
  hypesquad: false,
  giftBoxes: true,
  emoji: true,
  stickers: true,
  uploads: true,
  theme: true,
  tier: 2,
};

let config = { ...DEFAULTS };
let patches = [];
let constantOriginals = [];
let userOriginals = new Map();
let diagnostics = [];
let ownId = null;
let loaded = false;

/* ---------------- state ---------------- */

function readConfig() {
  try {
    const raw = api.storage && api.storage.config;
    if (raw) config = { ...DEFAULTS, ...JSON.parse(JSON.stringify(raw)) };
  } catch {}
}

function persist() {
  try {
    api.storage.config = JSON.parse(JSON.stringify(config));
  } catch {}
}

function repaint() {
  for (const type of ["CURRENT_USER_UPDATE", "USER_PROFILE_UPDATE"]) {
    try {
      api.flux.dispatch({ type });
    } catch {}
  }
}

/* ---------------- plumbing ---------------- */

function record(name, ok, detail) {
  diagnostics.push({ name, ok, detail: detail || (ok ? "ok" : "not found") });
  return ok;
}

function surface(name, fn) {
  try {
    const ok = fn();
    if (ok !== false) record(name, true);
  } catch (e) {
    record(name, false, String(e && e.message ? e.message : e));
  }
}

function hook(target, method, cb) {
  if (!target || typeof target[method] !== "function") return false;
  
  // Compatibility patch for different Revenge/Vencord API versions
  let unpatch;
  try {
    if (typeof api.patcher.after === 'function') {
      unpatch = api.patcher.after(target, method, cb);
    } else if (typeof api.patcher.hook === 'function') {
      // Fallback for older or custom builds
      unpatch = api.patcher.hook(target, method, cb);
    } else {
      return false;
    }
    if (unpatch && typeof unpatch === 'function') {
      patches.push(unpatch);
      return true;
    }
  } catch (err) {
    console.warn("[NitroSpoofer] Patch failed:", err);
    return false;
  }
  return false;
}

function lookup() {
  for (const props of arguments) {
    try {
      const mod = api.metro.findByProps(...props);
      if (mod) return mod;
    } catch {}
  }
  return null;
}

/* ---------------- spoofing ---------------- */

function spoofUser(user) {
  if (!user || !config.enabled || !user.id) return user;
  if (!userOriginals.has(user.id)) {
    userOriginals.set(user.id, {
      premiumType: user.premiumType,
      premiumSince: user.premiumSince,
      premiumGiftBoxCount: user.premiumGiftBoxCount,
      flags: user.flags,
    });
  }
  user.premiumType = config.tier;
  if (!user.premiumSince) user.premiumSince = PREMIUM_SINCE;
  if (config.giftBoxes && !user.premiumGiftBoxCount) user.premiumGiftBoxCount = 3;

  let flags = user.flags | 0;
  if (config.badge) flags |= FLAG_EARLY_SUPPORTER;
  if (config.hypesquad) flags |= FLAG_HYPESQUAD_BRAVERY;
  user.flags = flags;

  return user;
}

function restoreUsers() {
  for (const [id, saved] of userOriginals) {
    try {
      const store = lookup(["getCurrentUser", "getUser"]);
      if (!store) continue;
      const user = store.getUser(id) ?? null;
      if (!user) continue;
      for (const key of Object.keys(saved)) user[key] = saved[key];
    } catch {}
  }
  userOriginals.clear();
}

/* ---------------- surfaces ---------------- */

function patchUsers() {
  surface("user store", () => {
    const store = lookup(["getCurrentUser", "getUser"], ["getCurrentUser"], ["getUser"]);
    if (!store) return false;
    try {
      ownId = store.getCurrentUser()?.id ?? null;
    } catch {}
    const isMe = (id) => id != null && id === ownId;

    hook(store, "getCurrentUser", (_s, _a, res) => spoofUser(res));
    hook(store, "getUser", (_s, args, res) => (isMe(args[0]) ? spoofUser(res) : res));
    hook(store, "getUsers", (_s, _a, res) => {
      if (Array.isArray(res)) for (const u of res) if (isMe(u && u.id)) spoofUser(u);
      return res;
    });
    return true;
  });
}

function patchSubscription() {
  surface("premium subscription", () => {
    const store = lookup(["getPremiumTypeSubscription"], ["getPremiumSubscription"]);
    if (!store) return false;
    hook(store, "getPremiumTypeSubscription", () => ({ premiumType: config.tier }));
    hook(store, "getPremiumSubscription", () => ({
      premiumType: config.tier,
      isPremium: true,
    }));
    return true;
  });
}

function patchEmoji() {
  if (!config.emoji) return;
  surface("emoji checks", () => {
    const mod = lookup(["canUseEmojisEverywhere"], ["canUseAnimatedEmojis"], ["canUseExternalEmojis"]);
    if (!mod) return false;
    let any = false;
    for (const m of ["canUseEmojisEverywhere", "canUseAnimatedEmojis", "canUseExternalEmojis"]) {
      if (hook(mod, m, () => true)) any = true;
    }
    return any;
  });
}

function patchStickers() {
  if (!config.stickers) return;
  surface("sticker checks", () => {
    const mod = lookup(["canUseStickersEverywhere"], ["canUseExternalStickers"], ["canUseCustomStickersEverywhere"]);
    if (!mod) return false;
    let any = false;
    for (const m of ["canUseStickersEverywhere", "canUseExternalStickers", "canUseCustomStickersEverywhere"]) {
      if (hook(mod, m, () => true)) any = true;
    }
    return any;
  });
}

function patchUploads() {
  if (!config.uploads) return;
  surface("upload cap", () => {
    const holder = lookup(["NitroConstants"])?.NitroConstants ?? lookup(["MAX_UPLOAD_SIZE"]);
    if (!holder) return false;
    let any = false;
    for (const key of ["MAX_UPLOAD_SIZE", "MAX_UPLOAD_SIZE_BOOSTED", "MAX_ATTACHMENT_SIZE"]) {
      const value = holder[key];
      if (typeof value !== "number" || value >= UPLOAD_CAP) continue;
      constantOriginals.push([holder, key, value]);
      holder[key] = UPLOAD_CAP;
      any = true;
    }
    return any;
  });
}

function patchProfile() {
  if (!config.theme) return;
  surface("profile theme", () => {
    const store = lookup(["getUserProfile"], ["getUserProfile", "getGuildMemberProfile"]);
    if (!store) return false;
    hook(store, "getUserProfile", (_s, args, res) => {
      if (!res || !config.enabled || args[0] !== ownId) return res;
      res.premiumType = config.tier;
      if (!res.premiumSince) res.premiumSince = PREMIUM_SINCE;
      if (!res.themeColors) res.themeColors = [0x5865f2, 0xeb4599];
      return res;
    });
    return true;
  });
}

/* ---------------- lifecycle ---------------- */

function applyAll() {
  if (!api || !api.patcher || !api.metro) return;
  diagnostics = [];
  patchUsers();
  patchSubscription();
  patchEmoji();
  patchStickers();
  patchUploads();
  patchProfile();
  repaint();
}

function revertAll() {
  for (const unpatch of patches.splice(0)) {
    try {
      unpatch();
    } catch {}
  }
  for (const [holder, key, value] of constantOriginals.splice(0)) {
    try {
      holder[key] = value;
    } catch {}
  }
  restoreUsers();
  repaint();
}

/* ---------------- settings ---------------- */

function Settings() {
  const React = api.metro?.common?.React;
  const C = api.ui?.components;
  if (!React || !C) return null;

  const h = React.createElement;
  const [, bump] = React.useState(0);
  const section = C.FormSection ?? C.FormRow;

  const set = (key, value) => {
    config[key] = value;
    persist();
    if (key === "enabled") {
      if (value) applyAll();
      else repaint();
    }
    bump((n) => n + 1);
  };

  const sw = (label, sub, key) =>
    h(C.FormSwitchRow, {
      label,
      subLabel: sub,
      value: !!config[key],
      onValueChange: (v) => set(key, v),
    });

  const divider = C.FormDivider ? h(C.FormDivider) : null;
  const okCount = diagnostics.filter((d) => d.ok).length;

  return h(
    section,
    { title: "Nitro Spoofer" },
    sw("Enabled", "Master switch. Nothing below applies while off.", "enabled"),
    divider,
    sw("Premium badge", "Early-supporter flag on your own user object.", "badge"),
    sw("HypeSquad badge", "Adds the Bravery house flag as well.", "hypesquad"),
    sw("Gift inventory", "Shows 3 unopened gift boxes on your account.", "giftBoxes"),
    sw("Emoji anywhere", "Bypasses the client-side external and animated emoji checks.", "emoji"),
    sw("Stickers anywhere", "Same, for stickers.", "stickers"),
    sw("Oversized uploads", "Local cap to 500 MB. The server still has final say.", "uploads"),
    sw("Profile theme", "Blurple to pink gradient on your own profile card.", "theme"),
    divider,
    h(C.FormRow, {
      label: "Tier",
      subLabel: TIER_LABEL[config.tier],
      onPress: () => set("tier", TIER_CYCLE[config.tier]),
    }),
    h(C.FormRow, {
      label: "Re-apply patches",
      subLabel: `${patches.length} active · ${okCount}/${diagnostics.length} surfaces`,
      onPress: () => {
        revertAll();
        applyAll();
        bump((n) => n + 1);
      },
    }),
    divider,
    h(section, { title: "Diagnostics" },
      ...(diagnostics.length
        ? diagnostics.map((d, i) =>
            h(C.FormRow, { key: String(i), label: d.name, subLabel: d.detail })
          )
        : [h(C.FormRow, { key: "none", label: "Nothing applied yet" })])
    ),
    h(C.FormRow, {
      label: "Cosmetic only",
      subLabel: "No API calls. Other people see the real account.",
    })
  );
}

export default {
  onLoad() {
    if (loaded) return;
    loaded = true;
    readConfig();
    applyAll();

    if (!patches.length) {
      setTimeout(() => {
        if (!patches.length) applyAll();
      }, 1500);
    }
    console.log("[NitroSpoofer] loaded", patches.length, "patches");
  },

  onUnload() {
    loaded = false;
    revertAll();
    console.log("[NitroSpoofer] unloaded");
  },

  settings: Settings,
};