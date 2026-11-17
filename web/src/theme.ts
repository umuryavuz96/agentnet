// Theme choice per device: system (default), light or dark. The embed host's theme still wins.
import { ref } from "vue";
export type ThemePref = "system" | "light" | "dark";
const KEY = "agentnet.theme";
const read = (): ThemePref => { try { const v = localStorage.getItem(KEY); return v === "light" || v === "dark" ? v : "system"; } catch { return "system"; } };
export const themePref = ref<ThemePref>(read());
export function setThemePref(v: ThemePref) { themePref.value = v; try { v === "system" ? localStorage.removeItem(KEY) : localStorage.setItem(KEY, v); } catch { /* storage blocked: the choice lasts until reload */ } }
