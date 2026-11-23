// Lucide icons used by the web app (24 px grid, stroke 1.8). Add one here, then use it as <Icon name="…">; only these end up in the bundle.
import { Brain, Trophy, Activity, Cpu, AppWindow, Ellipsis, ArrowRight, ArrowUpRight, Check, ChevronDown, Clock, Layers, Terminal, Pen, MessageCircle, ChartLine, Circle, CircleArrowUp, CircleCheck, CircleStop, CircleX, Copy, ExternalLink, FileText, FolderOpen, Gauge, GitCommitHorizontal, History, Image, LayoutGrid, LoaderCircle, Lock, Maximize2, Menu, MessagesSquare, Minus, Network, Plus, RotateCcw, Search, Send, Settings, ShieldCheck, SlidersHorizontal, Sparkles, Square, SquareTerminal, Trash2, TriangleAlert, User, Users, Webhook, X } from "lucide-vue-next";

export const ICONS = {
  trophy: Trophy, brain: Brain,
  "file-text": FileText, "git-commit-horizontal": GitCommitHorizontal, user: User, activity: Activity, cpu: Cpu, "arrow-right": ArrowRight, "arrow-up-right": ArrowUpRight, check: Check, circle: Circle, "circle-arrow-up": CircleArrowUp, "circle-x": CircleX, "rotate-ccw": RotateCcw, "chevron-down": ChevronDown, "chart-line": ChartLine, "circle-check": CircleCheck, "circle-stop": CircleStop, copy: Copy,
  "external-link": ExternalLink, gauge: Gauge, history: History, image: Image, "layout-grid": LayoutGrid, loader: LoaderCircle, lock: Lock, maximize: Maximize2,
  menu: Menu, message: MessagesSquare, minus: Minus, network: Network, plus: Plus, search: Search, send: Send, settings: Settings, "shield-check": ShieldCheck,
  "folder-open": FolderOpen, sliders: SlidersHorizontal, sparkles: Sparkles, square: Square, "square-terminal": SquareTerminal, trash: Trash2, "triangle-alert": TriangleAlert, users: Users,
  clock: Clock, layers: Layers, terminal: Terminal, pen: Pen, "message-circle": MessageCircle,
  webhook: Webhook, x: X, ellipsis: Ellipsis, "app-window": AppWindow,
} as const;
export type IconName = keyof typeof ICONS;
