// Lucide icons used by the web app (24 px grid, stroke 1.8). Add one here, then use it as <Icon name="…">; only these end up in the bundle.
import { ArrowRight, ArrowUpRight, Check, ChevronDown, ChartLine, Circle, CircleArrowUp, CircleCheck, CircleX, Copy, ExternalLink, Gauge, History, LayoutGrid, LoaderCircle, Lock, Maximize2, Menu, MessagesSquare, Minus, Network, Plus, RotateCcw, Search, Send, ShieldCheck, SlidersHorizontal, Sparkles, Square, SquareTerminal, Trash2, TriangleAlert, Users, Webhook, X } from "lucide-vue-next";

export const ICONS = {
  "arrow-right": ArrowRight, "arrow-up-right": ArrowUpRight, check: Check, circle: Circle, "circle-arrow-up": CircleArrowUp, "circle-x": CircleX, "rotate-ccw": RotateCcw, "chevron-down": ChevronDown, "chart-line": ChartLine, "circle-check": CircleCheck, copy: Copy,
  "external-link": ExternalLink, gauge: Gauge, history: History, "layout-grid": LayoutGrid, loader: LoaderCircle, lock: Lock, maximize: Maximize2,
  menu: Menu, message: MessagesSquare, minus: Minus, network: Network, plus: Plus, search: Search, send: Send, "shield-check": ShieldCheck,
  sliders: SlidersHorizontal, sparkles: Sparkles, square: Square, "square-terminal": SquareTerminal, trash: Trash2, "triangle-alert": TriangleAlert, users: Users,
  webhook: Webhook, x: X,
} as const;
export type IconName = keyof typeof ICONS;
