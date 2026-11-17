// 3D office choices saved per device.
import { ref } from "vue";
const KEY = "agentnet.office.blur";
const read = () => { try { return localStorage.getItem(KEY) !== "off"; } catch { return true; } };
/** The miniature (tilt-shift) blur at the top and bottom of the 3D office. On by default. */
export const officeBlur = ref<boolean>(read());
export function setOfficeBlur(on: boolean) { officeBlur.value = on; try { on ? localStorage.removeItem(KEY) : localStorage.setItem(KEY, "off"); } catch { /* storage blocked: the choice lasts until reload */ } }
