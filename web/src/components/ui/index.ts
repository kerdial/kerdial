/**
 * The Kerdial primitive kit.
 *
 * One barrel so a screen imports its primitives from a single place, and so
 * "is this component part of the kit?" has a mechanical answer.
 *
 * Not exported, deliberately:
 * - `Switch` — no call site once the dark-mode toggle is dropped (D4).
 *   Build it on first need, not speculatively.
 * - the gamification set — excluded from both milestones.
 */
export { AllocationBar, type AllocationBarProps, type AllocationSegment } from "./AllocationBar.js";
export { AssetClassChip, type AssetClassChipProps } from "./AssetClassChip.js";
export { AssetRow, type AssetRowProps } from "./AssetRow.js";
export { Badge, type BadgeProps, type BadgeTone } from "./Badge.js";
export { Banner, type BannerProps, type BannerTone } from "./Banner.js";
export { Brand, type BrandProps } from "./Brand.js";
export { Button, type ButtonProps, type ButtonSize, type ButtonVariant } from "./Button.js";
export { Card, type CardProps, type CardTone } from "./Card.js";
export { Checkbox, type CheckboxProps } from "./Checkbox.js";
export { DeltaValue, deltaSign, type DeltaSign, type DeltaValueProps } from "./DeltaValue.js";
export { Dialog, type DialogProps } from "./Dialog.js";
export {
  DonutAllocation,
  sliceGeometry,
  sliceLayout,
  type DonutAllocationProps,
  type DonutSegment,
  type SliceLayout,
} from "./DonutAllocation.js";
export {
  DefinitionHint,
  GlossaryHint,
  JargonTerm,
  type DefinitionHintProps,
  type GlossaryHintProps,
  type JargonTermProps,
} from "./GlossaryHint.js";
export { Icon, ICON_NAMES, type IconName, type IconProps, type IconSize } from "./Icon.js";
export { IconButton, type IconButtonProps, type IconButtonVariant } from "./IconButton.js";
export { Input, type InputProps } from "./Input.js";
export { ProgressBar, type ProgressBarProps, type ProgressTone } from "./ProgressBar.js";
export {
  SegmentedControl,
  type SegmentedControlProps,
  type SegmentedOption,
} from "./SegmentedControl.js";
export { Select, type SelectOption, type SelectProps } from "./Select.js";
export { Skeleton, type SkeletonProps } from "./Skeleton.js";
export { Sparkline, type SparklineProps } from "./Sparkline.js";
export { StatTile, type StatTileProps, type StatTileTone } from "./StatTile.js";
export { Tabs, type TabItem, type TabsProps } from "./Tabs.js";
export { Tag, type TagProps } from "./Tag.js";
export { Toast, type ToastProps } from "./Toast.js";
export { TransactionRow, type TransactionRowProps } from "./TransactionRow.js";
export { Tooltip, type TooltipProps } from "./Tooltip.js";
export { SortableHeader, type SortableHeaderProps } from "./SortableHeader.js";
