/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/activitybarpart.css';
import './media/activityaction.css';
import { localize, localize2 } from '../../../../nls.js';
import { ActionsOrientation } from '../../../../base/browser/ui/actionbar/actionbar.js';
import { Part } from '../../part.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { ActivityBarPosition, AuxiliaryActivityBarPosition, IWorkbenchLayoutService, LayoutSettings, Parts, Position, FLOATING_PANEL_INNER_MARGIN, FLOATING_PANEL_MARGIN, getFloatingPanelMargin, getFloatingPanelOuterMargin, isFloatingTopEdgeExposed } from '../../../services/layout/browser/layoutService.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { Event } from '../../../../base/common/event.js';
import { ToggleSidebarPositionAction, ToggleSidebarVisibilityAction } from '../../actions/layoutActions.js';
import { IThemeService, IColorTheme, registerThemingParticipant } from '../../../../platform/theme/common/themeService.js';
import { ACTIVITY_BAR_BACKGROUND, ACTIVITY_BAR_BORDER, ACTIVITY_BAR_FOREGROUND, ACTIVITY_BAR_ACTIVE_BORDER, ACTIVITY_BAR_BADGE_BACKGROUND, ACTIVITY_BAR_BADGE_FOREGROUND, ACTIVITY_BAR_INACTIVE_FOREGROUND, ACTIVITY_BAR_ACTIVE_BACKGROUND, ACTIVITY_BAR_DRAG_AND_DROP_BORDER, ACTIVITY_BAR_ACTIVE_FOCUS_BORDER, MODERN_ACTIVITY_BAR_BACKGROUND, MODERN_ACTIVITY_BAR_INACTIVE_BACKGROUND } from '../../../common/theme.js';
import { activeContrastBorder, contrastBorder, focusBorder } from '../../../../platform/theme/common/colorRegistry.js';
import { addDisposableListener, append, EventType, isAncestor, $, clearNode, Dimension } from '../../../../base/browser/dom.js';
import { assertReturnsDefined } from '../../../../base/common/types.js';
import { CustomMenubarControl } from '../titlebar/menubarControl.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { getMenuBarVisibility, MenuSettings } from '../../../../platform/window/common/window.js';
import { IAction, Separator, SubmenuAction, toAction } from '../../../../base/common/actions.js';
import { StandardKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { KeyCode } from '../../../../base/common/keyCodes.js';
import { HoverPosition } from '../../../../base/browser/ui/hover/hoverWidget.js';
import { GestureEvent } from '../../../../base/browser/touch.js';
import { IPaneCompositePart } from '../paneCompositePart.js';
import { IPaneCompositeBarFilter, IPaneCompositeBarOptions, PaneCompositeBar } from '../paneCompositeBar.js';
import { CompositeDragAndDropObserver } from '../../dnd.js';
import { GlobalCompositeBar } from '../globalCompositeBar.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { Action2, IMenuService, MenuId, MenuRegistry, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr, IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IsSessionsWindowContext } from '../../../common/contextkeys.js';
import { Categories } from '../../../../platform/action/common/actionCommonCategories.js';
import { getContextMenuActions } from '../../../../platform/actions/browser/menuEntryActionViewItem.js';
import { IViewDescriptorService, ViewContainerLocation, ViewContainerLocationToString } from '../../../common/views.js';
import { IExtensionService } from '../../../services/extensions/common/extensions.js';
import { IWorkbenchEnvironmentService } from '../../../services/environment/common/environmentService.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { SwitchCompositeViewAction } from '../compositeBarActions.js';
import { IHostService } from '../../../services/host/browser/host.js';
import { ToggleAuxiliaryBarAction } from '../auxiliarybar/auxiliaryBarActions.js';

/**
 * Configures which rail an {@link ActivitybarPart} instance is. The workbench has two: the
 * primary activity bar beside the Primary Side Bar, and the secondary activity bar beside
 * the Secondary Side Bar on the opposite edge. Both share the same rendering; they differ in
 * the part they are and the storage keys of the pinned view containers. The primary rail hosts
 * Accounts and the compact menu bar; Manage sits at the bottom of the secondary rail, or of the
 * primary rail while the secondary rail is hidden.
 */
export interface IActivitybarPartOptions {
	readonly partId: Parts.ACTIVITYBAR_PART | Parts.AUXILIARY_ACTIVITYBAR_PART;
	readonly pinnedViewContainersKey: string;
	readonly placeholderViewContainersKey: string;
	readonly viewContainersWorkspaceStateKey: string;
	/** When the side bar can split, the rail shows a second group of items for its bottom half. */
	readonly split?: IActivitybarSplitOptions;
}

/**
 * The bottom group of a rail whose side bar is split into a top and a bottom half. The rail
 * shows the top half's view containers in its usual group and the bottom half's view
 * containers in a second group anchored to the bottom of the rail.
 */
export interface IActivitybarSplitOptions {
	readonly bottomPart: IPaneCompositePart;
	readonly topFilter: IPaneCompositeBarFilter;
	readonly bottomFilter: IPaneCompositeBarFilter;
	readonly bottomPinnedViewContainersKey: string;
	readonly bottomPlaceholderViewContainersKey: string;
	readonly bottomViewContainersWorkspaceStateKey: string;
	readonly getMoveActions: (viewContainerId: string) => IAction[];
}

/**
 * A second group of items on a vertical rail, for the bottom half of a split side bar.
 */
interface IActivityBarBottomGroup {
	readonly paneCompositePart: IPaneCompositePart;
	readonly options: IPaneCompositeBarOptions;
}

export class ActivitybarPart extends Part {

	static readonly ACTION_HEIGHT = 48;
	static readonly COMPACT_ACTION_HEIGHT = 28;

	static readonly ACTIVITYBAR_WIDTH = 48;
	static readonly COMPACT_ACTIVITYBAR_WIDTH = 36;

	/** Narrower dimensions used when the floating panels (Modern UI) experiment is enabled. */
	static readonly FLOATING_ACTION_HEIGHT = 36;
	static readonly FLOATING_ACTIVITYBAR_WIDTH = 36;
	static readonly FLOATING_COMPACT_ACTIVITYBAR_WIDTH = 28;

	/**
	 * Vertical gap between activity bar items at the default size under the floating
	 * panels experiment. Published to CSS as `--activity-bar-action-gap` so that the
	 * stylesheet and the overflow computation cannot drift apart.
	 */
	static readonly FLOATING_ACTION_GAP = 8;

	/**
	 * The compact Modern UI density tightens that gap to match its denser rhythm.
	 */
	static readonly FLOATING_COMPACT_ACTION_GAP = 4;

	static readonly ICON_SIZE = 24;
	static readonly COMPACT_ICON_SIZE = 16;

	/**
	 * Base gutter reserved around the activity bar under the floating panels
	 * experiment. Must match the margins applied in `floatingPanels.css`.
	 */
	static readonly FLOATING_MARGIN = FLOATING_PANEL_MARGIN;

	/**
	 * The rail's own horizontal padding, doubled: the space inside the card beside the icon
	 * column. Independent of the cluster perimeter so the icons keep their inset whatever the
	 * gutter is. Must match `--modern-ui-activitybar-lane` in `floatingPanels.css`.
	 */
	static readonly FLOATING_LANE = 8;
	static readonly FLOATING_COMPACT_LANE = 4;

	/**
	 * The card border the activity bar draws on each edge under the floating panels
	 * experiment. Must match the border width applied in `floatingPanels.css`.
	 */
	static readonly FLOATING_BORDER = 1;

	static readonly pinnedViewContainersKey = 'workbench.activity.pinnedViewlets2';
	static readonly placeholderViewContainersKey = 'workbench.activity.placeholderViewlets';
	static readonly viewContainersWorkspaceStateKey = 'workbench.activity.viewletsWorkspaceState';

	//#region IView

	get minimumWidth(): number { return this.baseWidth + this.floatingHorizontalGutter; }
	get maximumWidth(): number { return this.baseWidth + this.floatingHorizontalGutter; }
	readonly minimumHeight: number = 0;
	readonly maximumHeight: number = Number.POSITIVE_INFINITY;

	//#endregion

	/** The intrinsic activity bar width (excludes any floating gutter). */
	private get baseWidth(): number {
		if (this.layoutService.isFloatingPanelsEnabled()) {
			if (this._isCompact) {
				return ActivitybarPart.FLOATING_COMPACT_ACTIVITYBAR_WIDTH;
			}
			return ActivitybarPart.FLOATING_ACTIVITYBAR_WIDTH;
		}
		return this._isCompact ? ActivitybarPart.COMPACT_ACTIVITYBAR_WIDTH : ActivitybarPart.ACTIVITYBAR_WIDTH;
	}

	/** The action (item) height that drives visible item sizing. */
	private get actionHeight(): number {
		if (this._isCompact) {
			return ActivitybarPart.COMPACT_ACTION_HEIGHT;
		}
		if (this.layoutService.isFloatingPanelsEnabled()) {
			return ActivitybarPart.FLOATING_ACTION_HEIGHT;
		}
		return ActivitybarPart.ACTION_HEIGHT;
	}

	/**
	 * Vertical gap rendered between two adjacent items. Only the floating panels
	 * experiment separates items, and only at the default activity bar size; the compact
	 * Modern UI density tightens it to match its denser rhythm.
	 */
	private get actionGap(): number {
		if (!this.layoutService.isFloatingPanelsEnabled() || this._isCompact) {
			return 0;
		}

		return this.layoutService.isModernUICompact() ? ActivitybarPart.FLOATING_COMPACT_ACTION_GAP : ActivitybarPart.FLOATING_ACTION_GAP;
	}

	/**
	 * The vertical space a single item occupies in the bar (its height plus the gap that
	 * separates it from the next one). This drives the overflow computation, so it has to
	 * track the current activity bar size, otherwise items collapse into the overflow menu
	 * prematurely.
	 */
	private get compositeSize(): number {
		return this.actionHeight + this.actionGap;
	}

	private get floatingHorizontalGutter(): number {
		if (!this.layoutService.isFloatingPanelsEnabled()) {
			return 0;
		}

		// The cluster perimeter on the window side, plus the rail's own lane beside the icon
		// column, where the primary side bar meets it flush.
		const lane = this.layoutService.isModernUICompact() ? ActivitybarPart.FLOATING_COMPACT_LANE : ActivitybarPart.FLOATING_LANE;
		return getFloatingPanelOuterMargin(this.layoutService) + lane
			+ (this.needsFloatingLeadingGap ? getFloatingPanelMargin(this.layoutService) : 0);
	}

	/**
	 * Whether the rail has to supply the gap to the card before it. Under this system's
	 * leading-margin convention each card owns the gap on its leading edge, so a rail that
	 * follows the editor — on the right, with no side bar to connect to — reserves one more
	 * margin than it does when it leads. Compact density keeps its cards joined, so it never
	 * needs the gap. Mirrors `.nosidebar .part.activitybar.right` in `floatingPanels.css`.
	 */
	private get needsFloatingLeadingGap(): boolean {
		return !this.layoutService.isModernUICompact()
			&& !this.isOnLeft
			&& !this.layoutService.isVisible(this.attachedPartId);
	}

	/** The part this rail is for. */
	get partId(): Parts.ACTIVITYBAR_PART | Parts.AUXILIARY_ACTIVITYBAR_PART {
		return this.railOptions.partId;
	}

	/**
	 * The side bar this rail is attached to: the Primary Side Bar for the primary activity bar,
	 * the Secondary Side Bar for the secondary one.
	 */
	get attachedPartId(): Parts.SIDEBAR_PART | Parts.AUXILIARYBAR_PART {
		return this.partId === Parts.ACTIVITYBAR_PART ? Parts.SIDEBAR_PART : Parts.AUXILIARYBAR_PART;
	}

	/**
	 * Whether the rail sits on the left window edge. The primary rail follows the Primary Side Bar
	 * position, the secondary rail sits on the opposite edge.
	 */
	get isOnLeft(): boolean {
		const sideBarLeft = this.layoutService.getSideBarPosition() === Position.LEFT;
		return this.partId === Parts.ACTIVITYBAR_PART ? sideBarLeft : !sideBarLeft;
	}

	private readonly compositeBar = this._register(new MutableDisposable<PaneCompositeBar>());
	private content: HTMLElement | undefined;
	private _isCompact: boolean;
	private activeWindowId: number | undefined;

	constructor(
		private readonly location: ViewContainerLocation,
		private readonly paneCompositePart: IPaneCompositePart,
		private readonly railOptions: IActivitybarPartOptions,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IHostService private readonly hostService: IHostService,
	) {
		super(railOptions.partId, { hasTitle: false }, themeService, storageService, layoutService);

		this._isCompact = this.configurationService.getValue<boolean>(LayoutSettings.ACTIVITY_BAR_COMPACT) ?? false;

		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(LayoutSettings.ACTIVITY_BAR_COMPACT)) {
				this._isCompact = this.configurationService.getValue<boolean>(LayoutSettings.ACTIVITY_BAR_COMPACT) ?? false;
				this.updateCompactStyle();
				this.recreateCompositeBar();
				this._onDidChange.fire(undefined); // Signal grid that size constraints changed
			}

			// Floating panels changes the reserved left/bottom gutter (and therefore
			// the fixed part width): signal the grid that the size constraint changed.
			if (e.affectsConfiguration(LayoutSettings.MODERN_UI) || e.affectsConfiguration(LayoutSettings.MODERN_UI_DENSITY)) {
				this.updateCompactStyle();
				this.recreateCompositeBar();
				this._onDidChange.fire(undefined);
				if (this.element) {
					this.updateStyles();
				}
			}
		}));

		const updateStyles = () => {
			if (this.element) {
				this.updateStyles();
			}
		};
		this._register(this.hostService.onDidChangeFocus(updateStyles));
		this._register(this.hostService.onDidChangeActiveWindow(windowId => {
			this.activeWindowId = windowId;
			updateStyles();
		}));

		// Showing or hiding the attached side bar decides whether the rail connects to it or
		// stands alone, which can change the gutter it reserves (see `needsFloatingLeadingGap`).
		this._register(this.layoutService.onDidChangePartVisibility(e => {
			if (e.partId === this.attachedPartId && this.layoutService.isFloatingPanelsEnabled()) {
				this._onDidChange.fire(undefined);
			}
		}));
	}

	private updateCompactStyle(): void {
		if (this.element) {
			this.element.classList.toggle('compact', this._isCompact);
			// Mirrored on the workbench root for floatingPanels.css (the status bar aligns to the primary rail)
			if (this.partId === Parts.ACTIVITYBAR_PART) {
				this.layoutService.mainContainer.classList.toggle('activitybar-compact', this._isCompact);
			}
			this.element.style.setProperty('--activity-bar-width', `${this.baseWidth}px`);
			this.element.style.setProperty('--activity-bar-action-height', `${this.actionHeight}px`);
			this.element.style.setProperty('--activity-bar-action-gap', `${this.actionGap}px`);
			this.element.style.setProperty('--activity-bar-icon-size', `${this._isCompact ? ActivitybarPart.COMPACT_ICON_SIZE : ActivitybarPart.ICON_SIZE}px`);
		}
	}

	private recreateCompositeBar(): void {
		if (!this.content || !this.compositeBar.value) {
			return;
		}

		this.compositeBar.clear();
		clearNode(this.content);
		this.compositeBar.value = this.createCompositeBar();
		this.compositeBar.value.create(this.content);

		if (this.dimension) {
			this.layout(this.dimension.width, this.dimension.height);
		}
	}

	private createCompositeBar(): PaneCompositeBar {
		const compositeSize = this.compositeSize;
		const iconSize = this._isCompact ? ActivitybarPart.COMPACT_ICON_SIZE : ActivitybarPart.ICON_SIZE;
		const split = this.railOptions.split;

		const options: IPaneCompositeBarOptions = {
			partContainerClass: 'activitybar',
			pinnedViewContainersKey: this.railOptions.pinnedViewContainersKey,
			placeholderViewContainersKey: this.railOptions.placeholderViewContainersKey,
			viewContainersWorkspaceStateKey: this.railOptions.viewContainersWorkspaceStateKey,
			filter: split?.topFilter,
			transformContextMenuActionsForComposite: split ? (actions, id) => [...actions, ...split.getMoveActions(id)] : undefined,
			orientation: ActionsOrientation.VERTICAL,
			icon: true,
			iconSize,
			activityHoverOptions: {
				position: () => this.isOnLeft ? HoverPosition.RIGHT : HoverPosition.LEFT,
			},
			preventLoopNavigation: true,
			recomputeSizes: false,
			fillExtraContextMenuActions: (actions, e?: MouseEvent | GestureEvent) => { },
			compositeSize,
			colors: (theme: IColorTheme) => ({
				activeForegroundColor: theme.getColor(ACTIVITY_BAR_FOREGROUND),
				inactiveForegroundColor: theme.getColor(ACTIVITY_BAR_INACTIVE_FOREGROUND),
				activeBorderColor: theme.getColor(ACTIVITY_BAR_ACTIVE_BORDER),
				activeBackground: theme.getColor(ACTIVITY_BAR_ACTIVE_BACKGROUND),
				badgeBackground: theme.getColor(ACTIVITY_BAR_BADGE_BACKGROUND),
				badgeForeground: theme.getColor(ACTIVITY_BAR_BADGE_FOREGROUND),
				dragAndDropBorder: theme.getColor(ACTIVITY_BAR_DRAG_AND_DROP_BORDER),
				activeBackgroundColor: undefined, inactiveBackgroundColor: undefined, activeBorderBottomColor: undefined,
			}),
			overflowActionSize: compositeSize,
		};

		const bottomGroup: IActivityBarBottomGroup | undefined = split ? {
			paneCompositePart: split.bottomPart,
			options: {
				...options,
				pinnedViewContainersKey: split.bottomPinnedViewContainersKey,
				placeholderViewContainersKey: split.bottomPlaceholderViewContainersKey,
				viewContainersWorkspaceStateKey: split.bottomViewContainersWorkspaceStateKey,
				filter: split.bottomFilter,
			}
		} : undefined;

		return this.instantiationService.createInstance(ActivityBarCompositeBar, this.location, options, this.partId, this.paneCompositePart, { actionHeight: this.actionHeight, actionGap: this.actionGap }, bottomGroup);
	}

	protected override createContentArea(parent: HTMLElement): HTMLElement {
		this.element = parent;
		this.content = append(this.element, $('.content'));

		this.updateCompactStyle();

		if (this.layoutService.isVisible(this.partId)) {
			this.show();
		}

		return this.content;
	}

	/**
	 * Hides the view containers that start hidden on this rail again, in both of its groups.
	 */
	resetHiddenByDefault(): void {
		this.compositeBar.value?.resetHiddenByDefault();
	}

	getPinnedPaneCompositeIds(): string[] {
		return this.compositeBar.value?.getPinnedPaneCompositeIds() ?? [];
	}

	getVisiblePaneCompositeIds(): string[] {
		return this.compositeBar.value?.getVisiblePaneCompositeIds() ?? [];
	}

	getPaneCompositeIds(): string[] {
		return this.compositeBar.value?.getPaneCompositeIds() ?? [];
	}

	focus(): void {
		this.compositeBar.value?.focus();
	}

	override updateStyles(): void {
		super.updateStyles();

		const container = assertReturnsDefined(this.getContainer());
		let backgroundColor = ACTIVITY_BAR_BACKGROUND;
		if (this.configurationService.getValue<boolean>(LayoutSettings.MODERN_UI) === true) {
			const isWindowActive = this.activeWindowId === undefined ? mainWindow.document.hasFocus() : this.activeWindowId === mainWindow.vscodeWindowId;
			const isInactive = !this.hostService.hasFocus || !isWindowActive;
			backgroundColor = isInactive ? MODERN_ACTIVITY_BAR_INACTIVE_BACKGROUND : MODERN_ACTIVITY_BAR_BACKGROUND;
		}
		const background = this.getColor(backgroundColor) || '';
		container.style.backgroundColor = background;

		// In Modern UI the rail is a floating card whose border is owned by the stylesheet via
		// the `modernActivityBar.border` token. Leaving it out of the inline style lets CSS
		// vary it per edge (the seam it shares with the side bar) without needing `!important`.
		const borderColor = this.layoutService.isFloatingPanelsEnabled()
			? ''
			: this.getColor(ACTIVITY_BAR_BORDER) || this.getColor(contrastBorder) || '';
		container.classList.toggle('bordered', !!borderColor);
		container.style.borderColor = borderColor;
	}

	show(focus?: boolean): void {
		if (!this.content) {
			return;
		}

		if (!this.compositeBar.value) {
			this.compositeBar.value = this.createCompositeBar();
			this.compositeBar.value.create(this.content);

			if (this.dimension) {
				this.layout(this.dimension.width, this.dimension.height);
			}
		}

		if (focus) {
			this.focus();
		}
	}

	hide(): void {
		if (!this.compositeBar.value) {
			return;
		}

		this.compositeBar.clear();

		if (this.content) {
			clearNode(this.content);
		}
	}

	override layout(width: number, height: number): void {
		super.layout(width, height, 0, 0);

		if (!this.content) {
			return; // not created yet
		}

		const { top, bottom } = this.getFloatingGutters();
		const contentWidth = Math.max(0, width - this.floatingHorizontalGutter);
		const contentHeight = Math.max(0, height - top - bottom);

		// Layout contents
		const contentAreaSize = super.layoutContents(contentWidth, contentHeight).contentSize;

		// The first item has no preceding gap, so give one gap back to the composite bar.
		this.compositeBar.value?.layout(contentWidth, contentAreaSize.height + this.actionGap);
	}

	/**
	 * Vertical gutters (in pixels) mirroring the margins in `floatingPanels.css`, plus the
	 * card's 1px border on each edge (drawn inside the box, as `.monaco-workbench .part` is
	 * `box-sizing: border-box`). The top is flush with title/banner chrome and doubles only at
	 * an exposed window edge.
	 */
	private getFloatingGutters(): { top: number; bottom: number } {
		if (!this.layoutService.isFloatingPanelsEnabled()) {
			return { top: 0, bottom: 0 };
		}

		const margin = getFloatingPanelMargin(this.layoutService);
		const outerMargin = getFloatingPanelOuterMargin(this.layoutService);
		const border = ActivitybarPart.FLOATING_BORDER;
		return {
			top: border + (isFloatingTopEdgeExposed(this.layoutService, mainWindow) ? outerMargin : FLOATING_PANEL_INNER_MARGIN),
			bottom: border + (this.layoutService.isModernUICompact()
				? outerMargin
				: this.layoutService.isVisible(Parts.STATUSBAR_PART, mainWindow) ? margin : outerMargin)
		};
	}

	toJSON(): object {
		return {
			type: this.partId
		};
	}
}

export class ActivityBarCompositeBar extends PaneCompositeBar {

	private element: HTMLElement | undefined;

	private readonly menuBar = this._register(new MutableDisposable<CustomMenubarControl>());
	private menuBarContainer: HTMLElement | undefined;
	private compositeBarContainer: HTMLElement | undefined;
	private readonly globalCompositeBar: GlobalCompositeBar | undefined;
	private lastLayoutDimensions: Dimension | undefined;

	private readonly keyboardNavigationDisposables = this._register(new DisposableStore());

	private readonly bottomCompositeBar: PaneCompositeBar | undefined;
	private bottomGroupContainer: HTMLElement | undefined;
	private bottomGroupItemCount = 0;

	constructor(
		location: ViewContainerLocation,
		options: IPaneCompositeBarOptions,
		part: Parts,
		paneCompositePart: IPaneCompositePart,
		private readonly globalActivities: { readonly actionHeight: number; readonly actionGap: number } | undefined,
		bottomGroup: IActivityBarBottomGroup | undefined,
		@IInstantiationService instantiationService: IInstantiationService,
		@IStorageService storageService: IStorageService,
		@IExtensionService extensionService: IExtensionService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IViewsService viewService: IViewsService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IWorkbenchEnvironmentService environmentService: IWorkbenchEnvironmentService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IMenuService private readonly menuService: IMenuService,
		@IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
	) {
		super(location,
			{
				...options,
				fillExtraContextMenuActions: (actions, e) => {
					options.fillExtraContextMenuActions(actions, e);
					this.fillContextMenuActions(actions, e);
				}
			}, part, paneCompositePart, instantiationService, storageService, extensionService, viewDescriptorService, viewService, contextKeyService, environmentService, layoutService);

		if (globalActivities) {
			this.globalCompositeBar = this._register(instantiationService.createInstance(GlobalCompositeBar, () => this.getContextMenuActions(), (theme: IColorTheme) => this.options.colors(theme), this.options.activityHoverOptions));
			this._register(this.globalCompositeBar.onDidChange(() => {
				if (this.lastLayoutDimensions) {
					this.layout(this.lastLayoutDimensions.width, this.lastLayoutDimensions.height);
				}
			}));

			// Manage lives at the bottom of the secondary rail, and falls back to the primary
			// rail while the secondary rail is hidden so it stays reachable
			if (this.part === Parts.AUXILIARY_ACTIVITYBAR_PART) {
				this.globalCompositeBar.setVisibleActivities(false, true);
			} else {
				this._register(Event.filter(layoutService.onDidChangePartVisibility, e => e.partId === Parts.AUXILIARY_ACTIVITYBAR_PART)(() => this.updateGlobalActivities()));
				this._register(layoutService.onDidChangeAuxiliaryBarMaximized(() => this.updateGlobalActivities()));
			}
		}

		if (bottomGroup) {
			this.bottomCompositeBar = this._register(instantiationService.createInstance(PaneCompositeBar, location, {
				...bottomGroup.options,
				fillExtraContextMenuActions: (actions, e) => {
					bottomGroup.options.fillExtraContextMenuActions(actions, e);
					this.fillContextMenuActions(actions, e);
				}
			}, part, bottomGroup.paneCompositePart));
			this._register(this.bottomCompositeBar.onDidChangeComposites(() => {
				// The bar reports every re-render, so only relayout when its size has to change
				if (this.bottomCompositeBar?.getVisiblePaneCompositeIds().length !== this.bottomGroupItemCount) {
					this.relayout();
				}
			}));
		}

		// Register for configuration changes
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(MenuSettings.MenuBarVisibility) && this.supportsMenubar) {
				if (getMenuBarVisibility(this.configurationService) === 'compact') {
					this.installMenubar();
				} else {
					this.uninstallMenubar();
				}
			}
		}));
	}

	private updateGlobalActivities(): void {
		this.globalCompositeBar?.setVisibleActivities(true, !this.layoutService.isVisible(Parts.AUXILIARY_ACTIVITYBAR_PART));
	}

	/**
	 * Only the primary activity bar hosts the compact menu bar; the secondary rail never does.
	 */
	private get supportsMenubar(): boolean {
		return this.part === Parts.ACTIVITYBAR_PART;
	}

	private fillContextMenuActions(actions: IAction[], e?: MouseEvent | GestureEvent) {
		// Menu
		const menuBarVisibility = getMenuBarVisibility(this.configurationService);
		if (this.supportsMenubar && (menuBarVisibility === 'compact' || menuBarVisibility === 'hidden' || menuBarVisibility === 'toggle')) {
			actions.unshift(...[toAction({ id: 'toggleMenuVisibility', label: localize('menu', "Menu"), checked: menuBarVisibility === 'compact', run: () => this.configurationService.updateValue(MenuSettings.MenuBarVisibility, menuBarVisibility === 'compact' ? 'toggle' : 'compact') }), new Separator()]);
		}

		if (menuBarVisibility === 'compact' && this.menuBarContainer && e?.target) {
			if (isAncestor(e.target as Node, this.menuBarContainer)) {
				actions.unshift(...[toAction({ id: 'hideCompactMenu', label: localize('hideMenu', "Hide Menu"), run: () => this.configurationService.updateValue(MenuSettings.MenuBarVisibility, 'toggle') }), new Separator()]);
			}
		}

		// Global Composite Bar
		if (this.globalCompositeBar) {
			actions.push(new Separator());
			actions.push(...this.globalCompositeBar.getContextMenuActions());
		}
		actions.push(new Separator());
		actions.push(...this.getActivityBarContextMenuActions());
	}

	private uninstallMenubar() {
		if (this.menuBar.value) {
			this.menuBar.value = undefined;
		}

		if (this.menuBarContainer) {
			this.menuBarContainer.remove();
			this.menuBarContainer = undefined;
		}
	}

	private installMenubar() {
		if (this.menuBar.value) {
			return; // prevent menu bar from installing twice #110720
		}

		this.menuBarContainer = $('.menubar');

		const content = assertReturnsDefined(this.element);
		content.prepend(this.menuBarContainer);

		// Menubar: install a custom menu bar depending on configuration
		this.menuBar.value = this.instantiationService.createInstance(CustomMenubarControl);
		this.menuBar.value.create(this.menuBarContainer);

	}

	private registerKeyboardNavigationListeners(): void {
		this.keyboardNavigationDisposables.clear();

		// Up/Down or Left/Right arrow on compact menu
		if (this.menuBarContainer) {
			this.keyboardNavigationDisposables.add(addDisposableListener(this.menuBarContainer, EventType.KEY_DOWN, e => {
				const kbEvent = new StandardKeyboardEvent(e);
				if (kbEvent.equals(KeyCode.DownArrow) || kbEvent.equals(KeyCode.RightArrow)) {
					this.focus();
				}
			}));
		}

		// Up/Down on Activity Icons
		if (this.compositeBarContainer) {
			this.keyboardNavigationDisposables.add(addDisposableListener(this.compositeBarContainer, EventType.KEY_DOWN, e => {
				const kbEvent = new StandardKeyboardEvent(e);
				if (kbEvent.equals(KeyCode.DownArrow) || kbEvent.equals(KeyCode.RightArrow)) {
					this.globalCompositeBar?.focus();
				} else if (kbEvent.equals(KeyCode.UpArrow) || kbEvent.equals(KeyCode.LeftArrow)) {
					this.menuBar.value?.toggleFocus();
				}
			}));
		}

		// Up arrow on global icons
		if (this.globalCompositeBar) {
			this.keyboardNavigationDisposables.add(addDisposableListener(this.globalCompositeBar.element, EventType.KEY_DOWN, e => {
				const kbEvent = new StandardKeyboardEvent(e);
				if (kbEvent.equals(KeyCode.UpArrow) || kbEvent.equals(KeyCode.LeftArrow)) {
					this.focus(this.getVisiblePaneCompositeIds().length - 1);
				}
			}));
		}
	}

	override create(parent: HTMLElement): HTMLElement {
		this.element = parent;

		// Install menubar if compact
		if (this.supportsMenubar && getMenuBarVisibility(this.configurationService) === 'compact') {
			this.installMenubar();
		}

		// View Containers action bar
		this.compositeBarContainer = super.create(this.element);

		// View Containers of the bottom half of a split side bar
		if (this.bottomCompositeBar) {
			const bottomGroupContainer = this.bottomGroupContainer = append(this.element, $('.composite-bar-bottom-group'));
			this.bottomCompositeBar.create(bottomGroupContainer);

			// While a view container is dragged, an empty group shows room for one item to drop on
			this._register(CompositeDragAndDropObserver.INSTANCE.registerTarget(bottomGroupContainer, {
				onDragStart: () => {
					bottomGroupContainer.classList.add('dragging');
					this.relayout();
				},
				onDragEnd: () => {
					bottomGroupContainer.classList.remove('dragging');
					this.relayout();
				}
			}));
		}

		// Global action bar
		if (this.globalCompositeBar) {
			this.globalCompositeBar.create(this.element);
			if (this.part === Parts.ACTIVITYBAR_PART) {
				this.updateGlobalActivities();
			}
		}

		// Keyboard Navigation
		this.registerKeyboardNavigationListeners();

		return this.compositeBarContainer;
	}

	private relayout(): void {
		if (this.lastLayoutDimensions) {
			this.layout(this.lastLayoutDimensions.width, this.lastLayoutDimensions.height);
		}
	}

	override layout(width: number, height: number): void {
		this.lastLayoutDimensions = new Dimension(width, height);

		if (this.menuBarContainer) {
			if (this.options.orientation === ActionsOrientation.VERTICAL) {
				height -= this.menuBarContainer.clientHeight;
			} else {
				width -= this.menuBarContainer.clientWidth;
			}
		}
		if (this.globalCompositeBar && this.globalActivities) {
			if (this.options.orientation === ActionsOrientation.VERTICAL) {
				height -= this.globalCompositeBar.getHeight(this.globalActivities.actionHeight, this.globalActivities.actionGap);
			} else {
				width -= this.globalCompositeBar.element.clientWidth;
			}
		}
		if (this.bottomCompositeBar && this.bottomGroupContainer) {
			// The bottom group takes the room of its items, at most half of the rail. While
			// dragging, an empty group offers room for one item, but only room the top group
			// does not need, so dragging never pushes a top item into the overflow.
			const itemCount = this.bottomGroupItemCount = this.bottomCompositeBar.getVisiblePaneCompositeIds().length;
			const spareHeight = height - this.getVisiblePaneCompositeIds().length * this.options.compositeSize;
			const dropZone = itemCount === 0 && this.bottomGroupContainer.classList.contains('dragging') && spareHeight >= 2 * this.options.compositeSize ? 1 : 0;
			const bottomHeight = Math.max(0, Math.min((itemCount + dropZone) * this.options.compositeSize, Math.floor(height / 2)));
			this.bottomGroupContainer.style.height = `${bottomHeight}px`;
			this.bottomGroupContainer.classList.toggle('empty', itemCount === 0);
			this.bottomCompositeBar.layout(width, bottomHeight);
			height -= bottomHeight;
		}
		super.layout(width, height);
	}

	override resetHiddenByDefault(): void {
		super.resetHiddenByDefault();
		this.bottomCompositeBar?.resetHiddenByDefault();
	}

	getActivityBarContextMenuActions(): IAction[] {
		if (this.part === Parts.AUXILIARY_ACTIVITYBAR_PART) {
			return this.getAuxiliaryActivityBarContextMenuActions();
		}

		const activityBarPositionMenu = this.menuService.getMenuActions(MenuId.ActivityBarPositionMenu, this.contextKeyService, { shouldForwardArgs: true, renderShortTitle: true });
		const positionActions = getContextMenuActions(activityBarPositionMenu).secondary;
		const actions: IAction[] = [
			new SubmenuAction('workbench.action.activityBar.position', localize('activity bar position', "Activity Bar Position"), positionActions),
		];

		// Show size submenu only when activity bar is in default position
		const activityBarPosition = this.configurationService.getValue<string>(LayoutSettings.ACTIVITY_BAR_LOCATION);
		if (activityBarPosition === ActivityBarPosition.DEFAULT) {
			const isCompact = this.configurationService.getValue<boolean>(LayoutSettings.ACTIVITY_BAR_COMPACT) ?? false;
			const sizeActions = [
				toAction({ id: 'workbench.action.activityBar.size.default', label: localize('activityBarSizeDefault', "Default"), checked: !isCompact, run: () => this.configurationService.updateValue(LayoutSettings.ACTIVITY_BAR_COMPACT, false) }),
				toAction({ id: 'workbench.action.activityBar.size.compact', label: localize('activityBarSizeCompact', "Compact"), checked: isCompact, run: () => this.configurationService.updateValue(LayoutSettings.ACTIVITY_BAR_COMPACT, true) }),
			];
			actions.push(new SubmenuAction('workbench.action.activityBar.size', localize('activity bar size', "Activity Bar Size"), sizeActions));
		}

		actions.push(toAction({ id: ToggleSidebarPositionAction.ID, label: ToggleSidebarPositionAction.getLabel(this.layoutService), run: () => this.instantiationService.invokeFunction(accessor => new ToggleSidebarPositionAction().run(accessor)) }));

		if (this.part === Parts.SIDEBAR_PART) {
			actions.push(toAction({ id: ToggleSidebarVisibilityAction.ID, label: ToggleSidebarVisibilityAction.LABEL, run: () => this.instantiationService.invokeFunction(accessor => new ToggleSidebarVisibilityAction().run(accessor)) }));
		}

		return actions;
	}

	private getAuxiliaryActivityBarContextMenuActions(): IAction[] {
		const positionMenu = this.menuService.getMenuActions(MenuId.AuxiliaryActivityBarPositionMenu, this.contextKeyService, { shouldForwardArgs: true, renderShortTitle: true });
		const positionActions = getContextMenuActions(positionMenu).secondary;
		const actions: IAction[] = [
			new SubmenuAction('workbench.action.auxiliaryActivityBar.position', localize('secondary activity bar position', "Secondary Activity Bar Position"), positionActions),
		];

		// Size is shared with the primary rail and only applies in the default (rail) position
		const position = this.configurationService.getValue<string>(LayoutSettings.AUXILIARY_ACTIVITY_BAR_LOCATION);
		if (position === AuxiliaryActivityBarPosition.DEFAULT) {
			const isCompact = this.configurationService.getValue<boolean>(LayoutSettings.ACTIVITY_BAR_COMPACT) ?? false;
			const sizeActions = [
				toAction({ id: 'workbench.action.activityBar.size.default', label: localize('activityBarSizeDefault', "Default"), checked: !isCompact, run: () => this.configurationService.updateValue(LayoutSettings.ACTIVITY_BAR_COMPACT, false) }),
				toAction({ id: 'workbench.action.activityBar.size.compact', label: localize('activityBarSizeCompact', "Compact"), checked: isCompact, run: () => this.configurationService.updateValue(LayoutSettings.ACTIVITY_BAR_COMPACT, true) }),
			];
			actions.push(new SubmenuAction('workbench.action.activityBar.size', localize('activity bar size', "Activity Bar Size"), sizeActions));
		}

		const secondarySideBarOnRight = this.layoutService.getSideBarPosition() === Position.LEFT;
		actions.push(toAction({
			id: ToggleSidebarPositionAction.ID,
			label: secondarySideBarOnRight ? localize('move second side bar left', "Move Secondary Side Bar Left") : localize('move second side bar right', "Move Secondary Side Bar Right"),
			run: () => this.instantiationService.invokeFunction(accessor => new ToggleSidebarPositionAction().run(accessor))
		}));
		actions.push(toAction({
			id: ToggleAuxiliaryBarAction.ID,
			label: this.layoutService.isVisible(Parts.AUXILIARYBAR_PART) ? localize('hide second side bar', "Hide Secondary Side Bar") : localize('show second side bar', "Show Secondary Side Bar"),
			run: () => this.instantiationService.invokeFunction(accessor => new ToggleAuxiliaryBarAction().run(accessor))
		}));

		return actions;
	}

}

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.activityBarLocation.default',
			title: {
				...localize2('positionActivityBarDefault', 'Move Activity Bar to Side'),
				mnemonicTitle: localize({ key: 'miDefaultActivityBar', comment: ['&& denotes a mnemonic'] }, "&&Default"),
			},
			shortTitle: localize('default', "Default"),
			category: Categories.View,
			toggled: ContextKeyExpr.equals(`config.${LayoutSettings.ACTIVITY_BAR_LOCATION}`, ActivityBarPosition.DEFAULT),
			menu: [{
				id: MenuId.ActivityBarPositionMenu,
				order: 1
			}, {
				id: MenuId.CommandPalette,
				when: ContextKeyExpr.and(ContextKeyExpr.notEquals(`config.${LayoutSettings.ACTIVITY_BAR_LOCATION}`, ActivityBarPosition.DEFAULT), IsSessionsWindowContext.negate()),
			}]
		});
	}
	run(accessor: ServicesAccessor): void {
		const configurationService = accessor.get(IConfigurationService);
		configurationService.updateValue(LayoutSettings.ACTIVITY_BAR_LOCATION, ActivityBarPosition.DEFAULT);
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.activityBarLocation.top',
			title: {
				...localize2('positionActivityBarTop', 'Move Activity Bar to Top'),
				mnemonicTitle: localize({ key: 'miTopActivityBar', comment: ['&& denotes a mnemonic'] }, "&&Top"),
			},
			shortTitle: localize('top', "Top"),
			category: Categories.View,
			toggled: ContextKeyExpr.equals(`config.${LayoutSettings.ACTIVITY_BAR_LOCATION}`, ActivityBarPosition.TOP),
			menu: [{
				id: MenuId.ActivityBarPositionMenu,
				order: 2
			}, {
				id: MenuId.CommandPalette,
				when: ContextKeyExpr.and(ContextKeyExpr.notEquals(`config.${LayoutSettings.ACTIVITY_BAR_LOCATION}`, ActivityBarPosition.TOP), IsSessionsWindowContext.negate()),
			}]
		});
	}
	run(accessor: ServicesAccessor): void {
		const configurationService = accessor.get(IConfigurationService);
		configurationService.updateValue(LayoutSettings.ACTIVITY_BAR_LOCATION, ActivityBarPosition.TOP);
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.activityBarLocation.bottom',
			title: {
				...localize2('positionActivityBarBottom', 'Move Activity Bar to Bottom'),
				mnemonicTitle: localize({ key: 'miBottomActivityBar', comment: ['&& denotes a mnemonic'] }, "&&Bottom"),
			},
			shortTitle: localize('bottom', "Bottom"),
			category: Categories.View,
			toggled: ContextKeyExpr.equals(`config.${LayoutSettings.ACTIVITY_BAR_LOCATION}`, ActivityBarPosition.BOTTOM),
			menu: [{
				id: MenuId.ActivityBarPositionMenu,
				order: 3
			}, {
				id: MenuId.CommandPalette,
				when: ContextKeyExpr.and(ContextKeyExpr.notEquals(`config.${LayoutSettings.ACTIVITY_BAR_LOCATION}`, ActivityBarPosition.BOTTOM), IsSessionsWindowContext.negate()),
			}]
		});
	}
	run(accessor: ServicesAccessor): void {
		const configurationService = accessor.get(IConfigurationService);
		configurationService.updateValue(LayoutSettings.ACTIVITY_BAR_LOCATION, ActivityBarPosition.BOTTOM);
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.activityBarLocation.hide',
			title: {
				...localize2('hideActivityBar', 'Hide Activity Bar'),
				mnemonicTitle: localize({ key: 'miHideActivityBar', comment: ['&& denotes a mnemonic'] }, "&&Hidden"),
			},
			shortTitle: localize('hide', "Hidden"),
			category: Categories.View,
			toggled: ContextKeyExpr.equals(`config.${LayoutSettings.ACTIVITY_BAR_LOCATION}`, ActivityBarPosition.HIDDEN),
			menu: [{
				id: MenuId.ActivityBarPositionMenu,
				order: 4
			}, {
				id: MenuId.CommandPalette,
				when: ContextKeyExpr.and(ContextKeyExpr.notEquals(`config.${LayoutSettings.ACTIVITY_BAR_LOCATION}`, ActivityBarPosition.HIDDEN), IsSessionsWindowContext.negate()),
			}]
		});
	}
	run(accessor: ServicesAccessor): void {
		const configurationService = accessor.get(IConfigurationService);
		configurationService.updateValue(LayoutSettings.ACTIVITY_BAR_LOCATION, ActivityBarPosition.HIDDEN);
	}
});

MenuRegistry.appendMenuItem(MenuId.MenubarAppearanceMenu, {
	submenu: MenuId.ActivityBarPositionMenu,
	title: localize('positionActivituBar', "Activity Bar Position"),
	group: '3_workbench_layout_move',
	order: 2,
	when: IsSessionsWindowContext.negate()
});

MenuRegistry.appendMenuItem(MenuId.ViewContainerTitleContext, {
	submenu: MenuId.ActivityBarPositionMenu,
	title: localize('positionActivituBar', "Activity Bar Position"),
	when: ContextKeyExpr.equals('viewContainerLocation', ViewContainerLocationToString(ViewContainerLocation.Sidebar)),
	group: '3_workbench_layout_move',
	order: 1
});

//#region Secondary Activity Bar Position

class SetAuxiliaryActivityBarPositionAction extends Action2 {

	constructor(private readonly position: AuxiliaryActivityBarPosition, title: string, mnemonicTitle: string, shortTitle: string, order: number) {
		super({
			id: `workbench.action.secondaryActivityBarLocation.${position}`,
			title: { value: title, original: title, mnemonicTitle },
			shortTitle,
			category: Categories.View,
			toggled: ContextKeyExpr.equals(`config.${LayoutSettings.AUXILIARY_ACTIVITY_BAR_LOCATION}`, position),
			menu: [{
				id: MenuId.AuxiliaryActivityBarPositionMenu,
				order
			}, {
				id: MenuId.CommandPalette,
				when: ContextKeyExpr.and(ContextKeyExpr.notEquals(`config.${LayoutSettings.AUXILIARY_ACTIVITY_BAR_LOCATION}`, position), IsSessionsWindowContext.negate()),
			}]
		});
	}

	run(accessor: ServicesAccessor): Promise<void> {
		return accessor.get(IConfigurationService).updateValue(LayoutSettings.AUXILIARY_ACTIVITY_BAR_LOCATION, this.position);
	}
}

registerAction2(class extends SetAuxiliaryActivityBarPositionAction {
	constructor() {
		super(AuxiliaryActivityBarPosition.DEFAULT, localize('positionSecondaryActivityBarDefault', "Move Secondary Activity Bar to Side"), localize({ key: 'miDefaultSecondaryActivityBar', comment: ['&& denotes a mnemonic'] }, "&&Default"), localize('default', "Default"), 1);
	}
});

registerAction2(class extends SetAuxiliaryActivityBarPositionAction {
	constructor() {
		super(AuxiliaryActivityBarPosition.TITLE, localize('positionSecondaryActivityBarTitle', "Move Secondary Activity Bar to Title"), localize({ key: 'miTitleSecondaryActivityBar', comment: ['&& denotes a mnemonic'] }, "T&&itle"), localize('title', "Title"), 2);
	}
});

registerAction2(class extends SetAuxiliaryActivityBarPositionAction {
	constructor() {
		super(AuxiliaryActivityBarPosition.TOP, localize('positionSecondaryActivityBarTop', "Move Secondary Activity Bar to Top"), localize({ key: 'miTopSecondaryActivityBar', comment: ['&& denotes a mnemonic'] }, "&&Top"), localize('top', "Top"), 3);
	}
});

registerAction2(class extends SetAuxiliaryActivityBarPositionAction {
	constructor() {
		super(AuxiliaryActivityBarPosition.BOTTOM, localize('positionSecondaryActivityBarBottom', "Move Secondary Activity Bar to Bottom"), localize({ key: 'miBottomSecondaryActivityBar', comment: ['&& denotes a mnemonic'] }, "&&Bottom"), localize('bottom', "Bottom"), 4);
	}
});

registerAction2(class extends SetAuxiliaryActivityBarPositionAction {
	constructor() {
		super(AuxiliaryActivityBarPosition.HIDDEN, localize('hideSecondaryActivityBar', "Hide Secondary Activity Bar"), localize({ key: 'miHideSecondaryActivityBar', comment: ['&& denotes a mnemonic'] }, "&&Hidden"), localize('hide', "Hidden"), 5);
	}
});

MenuRegistry.appendMenuItem(MenuId.MenubarAppearanceMenu, {
	submenu: MenuId.AuxiliaryActivityBarPositionMenu,
	title: localize('positionSecondaryActivityBar', "Secondary Activity Bar Position"),
	group: '3_workbench_layout_move',
	order: 3,
	when: IsSessionsWindowContext.negate()
});

MenuRegistry.appendMenuItem(MenuId.ViewContainerTitleContext, {
	submenu: MenuId.AuxiliaryActivityBarPositionMenu,
	title: localize('positionSecondaryActivityBar', "Secondary Activity Bar Position"),
	when: ContextKeyExpr.equals('viewContainerLocation', ViewContainerLocationToString(ViewContainerLocation.AuxiliaryBar)),
	group: '3_workbench_layout_move',
	order: 1
});

//#endregion

registerAction2(class extends SwitchCompositeViewAction {
	constructor() {
		super({
			id: 'workbench.action.previousSideBarView',
			title: localize2('previousSideBarView', 'Previous Primary Side Bar View'),
			category: Categories.View,
			f1: true
		}, ViewContainerLocation.Sidebar, -1);
	}
});

registerAction2(class extends SwitchCompositeViewAction {
	constructor() {
		super({
			id: 'workbench.action.nextSideBarView',
			title: localize2('nextSideBarView', 'Next Primary Side Bar View'),
			category: Categories.View,
			f1: true
		}, ViewContainerLocation.Sidebar, 1);
	}
});

registerAction2(
	class FocusActivityBarAction extends Action2 {
		constructor() {
			super({
				id: 'workbench.action.focusActivityBar',
				title: localize2('focusActivityBar', 'Focus Activity Bar'),
				category: Categories.View,
				f1: true
			});
		}

		async run(accessor: ServicesAccessor): Promise<void> {
			const layoutService = accessor.get(IWorkbenchLayoutService);
			layoutService.focusPart(Parts.ACTIVITYBAR_PART);
		}
	});

registerAction2(
	class FocusAuxiliaryActivityBarAction extends Action2 {
		constructor() {
			super({
				id: 'workbench.action.focusSecondaryActivityBar',
				title: localize2('focusSecondaryActivityBar', 'Focus Secondary Activity Bar'),
				category: Categories.View,
				f1: true
			});
		}

		async run(accessor: ServicesAccessor): Promise<void> {
			const layoutService = accessor.get(IWorkbenchLayoutService);
			layoutService.focusPart(Parts.AUXILIARY_ACTIVITYBAR_PART);
		}
	});

registerThemingParticipant((theme, collector) => {

	const activityBarActiveBorderColor = theme.getColor(ACTIVITY_BAR_ACTIVE_BORDER);
	if (activityBarActiveBorderColor) {
		collector.addRule(`
			.monaco-workbench .activitybar > .content :not(.monaco-menu) > .monaco-action-bar .action-item.checked .active-item-indicator:before {
				border-left-color: ${activityBarActiveBorderColor};
			}
		`);
	}

	const activityBarActiveFocusBorderColor = theme.getColor(ACTIVITY_BAR_ACTIVE_FOCUS_BORDER);
	if (activityBarActiveFocusBorderColor) {
		collector.addRule(`
			.monaco-workbench .activitybar > .content :not(.monaco-menu) > .monaco-action-bar .action-item.checked:focus::before {
				visibility: hidden;
			}

			.monaco-workbench .activitybar > .content :not(.monaco-menu) > .monaco-action-bar .action-item.checked:focus .active-item-indicator:before {
				visibility: visible;
				border-left-color: ${activityBarActiveFocusBorderColor};
			}
		`);
	}

	const activityBarActiveBackgroundColor = theme.getColor(ACTIVITY_BAR_ACTIVE_BACKGROUND);
	if (activityBarActiveBackgroundColor) {
		collector.addRule(`
			.monaco-workbench .activitybar > .content :not(.monaco-menu) > .monaco-action-bar .action-item.checked .active-item-indicator {
				z-index: 0;
				background-color: ${activityBarActiveBackgroundColor};
			}
		`);
	}

	// Styling with Outline color (e.g. high contrast theme)
	const outline = theme.getColor(activeContrastBorder);
	if (outline) {
		collector.addRule(`
			.monaco-workbench .activitybar > .content :not(.monaco-menu) > .monaco-action-bar .action-item .action-label::before{
				padding: 6px;
			}

			.monaco-workbench .activitybar > .content :not(.monaco-menu) > .monaco-action-bar .action-item.active .action-label::before,
			.monaco-workbench .activitybar > .content :not(.monaco-menu) > .monaco-action-bar .action-item.active:hover .action-label::before,
			.monaco-workbench .activitybar > .content :not(.monaco-menu) > .monaco-action-bar .action-item.checked .action-label::before,
			.monaco-workbench .activitybar > .content :not(.monaco-menu) > .monaco-action-bar .action-item.checked:hover .action-label::before {
				outline: 1px solid ${outline};
			}

			.monaco-workbench .activitybar > .content :not(.monaco-menu) > .monaco-action-bar .action-item:hover .action-label::before {
				outline: 1px dashed ${outline};
			}

			.monaco-workbench .activitybar > .content :not(.monaco-menu) > .monaco-action-bar .action-item:focus .active-item-indicator:before {
				border-left-color: ${outline};
			}
		`);
	}

	// Styling without outline color
	else {
		const focusBorderColor = theme.getColor(focusBorder);
		if (focusBorderColor) {
			collector.addRule(`
				.monaco-workbench .activitybar > .content :not(.monaco-menu) > .monaco-action-bar .action-item:focus .active-item-indicator::before {
						border-left-color: ${focusBorderColor};
					}
				`);
		}
	}
});
