import {
  AlertTriangle,
  ArrowDownRight,
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  BadgeCheck,
  Ban,
  Banknote,
  Building2,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  CircleAlert,
  CircleCheck,
  CircleHelp,
  Clock,
  Coins,
  Download,
  Ellipsis,
  ExternalLink,
  Eye,
  FileText,
  Filter,
  Info,
  LayoutDashboard,
  LineChart,
  ListChecks,
  Loader2,
  LogOut,
  Menu,
  Pencil,
  Pin,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  SlidersHorizontal,
  Table2,
  Trash2,
  TrendingDown,
  TrendingUp,
  Upload,
  User,
  Users,
  Wallet,
  X,
  type LucideIcon,
} from "lucide-react";

/**
 * The one entry point for every icon in the app.
 *
 * Lucide, stroke 2,
 * `currentColor`, sizes 14/16/20/24/28, always through one wrapper — no inline
 * path data, no second icon library, no emoji or Unicode symbols standing in
 * for icons. `no-inline-icons.test.ts` enforces the negative half of that.
 *
 * ## Why the registry is explicit
 *
 * The design system's own contract takes a **string** name (`icon?: string` on
 * `Button`, `Badge`, `StatTile`, …), which is the ergonomic API and worth
 * keeping. But resolving a string against Lucide's full export at runtime
 * defeats tree-shaking and pulls the entire set — well over a thousand
 * components — into the bundle. The registry below is the reconciliation: call
 * sites keep the string API, while the bundle only ever contains the icons
 * named here. Adding one is a two-line change; forgetting to add one is a type
 * error, not a blank space at runtime.
 */
const REGISTRY = {
  "alert-triangle": AlertTriangle,
  "arrow-down-right": ArrowDownRight,
  "arrow-left": ArrowLeft,
  "arrow-right": ArrowRight,
  "arrow-up-right": ArrowUpRight,
  "badge-check": BadgeCheck,
  ban: Ban,
  banknote: Banknote,
  building: Building2,
  check: Check,
  "chevron-down": ChevronDown,
  "chevron-left": ChevronLeft,
  "chevron-right": ChevronRight,
  "chevron-up": ChevronUp,
  "circle-alert": CircleAlert,
  "circle-check": CircleCheck,
  "circle-help": CircleHelp,
  clock: Clock,
  coins: Coins,
  download: Download,
  ellipsis: Ellipsis,
  "external-link": ExternalLink,
  eye: Eye,
  "file-text": FileText,
  filter: Filter,
  info: Info,
  "layout-dashboard": LayoutDashboard,
  "line-chart": LineChart,
  "list-checks": ListChecks,
  loader: Loader2,
  "log-out": LogOut,
  menu: Menu,
  pencil: Pencil,
  pin: Pin,
  plus: Plus,
  "refresh-cw": RefreshCw,
  search: Search,
  settings: Settings2,
  sliders: SlidersHorizontal,
  table: Table2,
  trash: Trash2,
  "trending-down": TrendingDown,
  "trending-up": TrendingUp,
  upload: Upload,
  // `account-setup` FR-409/FR-420 — the account menu's two new entries.
  user: User,
  users: Users,
  wallet: Wallet,
  x: X,
} as const satisfies Record<string, LucideIcon>;

export type IconName = keyof typeof REGISTRY;

/** The five allowed sizes. A component may not invent a sixth. */
const SIZES = { xs: 14, sm: 16, md: 20, lg: 24, xl: 28 } as const;

export type IconSize = keyof typeof SIZES;

export interface IconProps {
  readonly name: IconName;
  /** Token size step. Defaults to `sm` (16px), the table/inline size. */
  readonly size?: IconSize;
  /** Marks the icon as meaningful rather than decorative, and gives it this label. */
  readonly label?: string;
  readonly className?: string;
}

/**
 * `label` is what decides the accessibility treatment, and the default is the
 * safe one: an unlabelled icon is `aria-hidden`, because the overwhelming
 * majority sit beside text that already says the same thing and would
 * otherwise be announced twice. `IconButton` is the case that always needs a
 * label, and its own contract makes it required.
 */
export function Icon({ name, size = "sm", label, className }: IconProps) {
  const Glyph = REGISTRY[name];
  const px = SIZES[size];

  return (
    <Glyph
      width={px}
      height={px}
      strokeWidth={2}
      color="currentColor"
      className={className}
      aria-hidden={label === undefined ? true : undefined}
      aria-label={label}
      role={label === undefined ? undefined : "img"}
      focusable={false}
    />
  );
}

/** Exported for tests and for the registry-completeness assertion. */
export const ICON_NAMES = Object.keys(REGISTRY) as readonly IconName[];
