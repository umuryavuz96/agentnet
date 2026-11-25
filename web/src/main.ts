import { createApp } from "vue";
import App from "./App.vue";
import "./ui/tokens.css";
import "./ui/side-panel.css";
import { installPanelResize } from "./ui/panelResize";

createApp(App).mount("#app");
installPanelResize();
