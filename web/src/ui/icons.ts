// Lucide icons used by the web app (24 px grid, stroke 1.8). Add one here, then use it as <Icon name="…">; only these end up in the bundle.
import { ArrowUpRight, Check, ChevronDown, ChartLine, CircleCheck, Copy, ExternalLink, Gauge, History, LayoutGrid, LoaderCircle, Lock, Maximize2, Menu, MessagesSquare, Minus, Network, Plus, Search, Send, ShieldCheck, SlidersHorizontal, Sparkles, Square, SquareTerminal, TriangleAlert, Users, Webhook, X } from "lucide-vue-next";

export const ICONS = {
  "arrow-up-right": ArrowUpRight, check: Check, "chevron-down": ChevronDown, "chart-line": ChartLine, "circle-check": CircleCheck, copy: Copy,
  "external-link": ExternalLink, gauge: Gauge, history: History, "layout-grid": LayoutGrid, loader: LoaderCircle, lock: Lock, maximize: Maximize2,
  menu: Menu, message: MessagesSquare, minus: Minus, network: Network, plus: Plus, search: Search, send: Send, "shield-check": ShieldCheck,
  sliders: SlidersHorizontal, sparkles: Sparkles, square: Square, "square-terminal": SquareTerminal, "triangle-alert": TriangleAlert, users: Users,
  webhook: Webhook, x: X,
} as const;
export type IconName = keyof typeof ICONS;
