import DefaultTheme from "vitepress/theme";
import type { Theme } from "vitepress";
import "@fontsource-variable/space-grotesk";
import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "./style.css";
import Landing from "./components/Landing.vue";
import Playground from "./components/Playground.vue";

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component("Landing", Landing);
    app.component("Playground", Playground);
  },
} satisfies Theme;
