/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/auxiliaryBarPart.css';
import { localize, localize2 } from '../../../../nls.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { contrastBorder } from '../../../../platform/theme/common/colorRegistry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { ActiveAuxiliaryBottomContext, ActiveAuxiliaryContext, AuxiliaryBarBottomFocusContext, AuxiliaryBarFocusContext } from '../../../common/contextkeys.js';
import { ACTIVITY_BAR_BADGE_BACKGROUND, ACTIVITY_BAR_BADGE_FOREGROUND, ACTIVITY_BAR_TOP_ACTIVE_BORDER, ACTIVITY_BAR_TOP_DRAG_AND_DROP_BORDER, ACTIVITY_BAR_TOP_FOREGROUND, ACTIVITY_BAR_TOP_INACTIVE_FOREGROUND, PANEL_ACTIVE_TITLE_BORDER, PANEL_ACTIVE_TITLE_FOREGROUND, PANEL_DRAG_AND_DROP_BORDER, PANEL_INACTIVE_TITLE_FOREGROUND, SIDE_BAR_BACKGROUND, SIDE_BAR_BORDER, SIDE_BAR_TITLE_BORDER, SIDE_BAR_FOREGROUND } from '../../../common/theme.js';
import { IViewDescriptorService, ViewContainerLocation } from '../../../common/views.js';
import { IExtensionService } from '../../../services/extensions/common/extensions.js';
import { AuxiliaryActivityBarPosition, IWorkbenchLayoutService, LayoutSettings, Parts, Position } from '../../../services/layout/browser/layoutService.js';
import { HoverPosition } from '../../../../base/browser/ui/hover/hoverWidget.js';
import { IAction, Separator, SubmenuAction, toAction } from '../../../../base/common/actions.js';
import { ToggleAuxiliaryBarAction } from './auxiliaryBarActions.js';
import { assertReturnsDefined } from '../../../../base/common/types.js';
import { LayoutPriority } from '../../../../base/browser/ui/splitview/splitview.js';
import { ToggleSecondaryActivityBarVisibilityActionId, ToggleSidebarPositionAction } from '../../actions/layoutActions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { AbstractPaneCompositePart, CompositeBarPosition, IPaneCompositeSplit } from '../paneCompositePart.js';
import { PaneCompositeSplit } from '../paneCompositeSplit.js';
import { IPaneComposite } from '../../../common/panecomposite.js';
import { Event } from '../../../../base/common/event.js';
import { IProgressIndicator } from '../../../../platform/progress/common/progress.js';
import { ActionsOrientation } from '../../../../base/browser/ui/actionbar/actionbar.js';
import { IPaneCompositeBarOptions } from '../paneCompositeBar.js';
import { Action2, IMenuService, MenuId, registerAction2, SubmenuItemAction } from '../../../../platform/actions/common/actions.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { getContextMenuActions } from '../../../../platform/actions/browser/menuEntryActionViewItem.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { VisibleViewContainersTracker } from '../visibleViewContainersTracker.js';
import { Extensions } from '../../panecomposite.js';
import { IToolBarResponsiveBehaviorOptions } from '../../../../base/browser/ui/toolbar/toolbar.js';
import { ActivitybarPart } from '../activitybar/activitybarPart.js';

interface IAuxiliaryBarPartConfiguration {
	position: AuxiliaryActivityBarPosition;

	canShowLabels: boolean;
	showLabels: boolean;
}

export class AuxiliaryBarPart extends AbstractPaneCompositePart {

	static readonly activeViewSettingsKey = 'workbench.auxiliarybar.activepanelid';
	static readonly pinnedViewsKey = 'workbench.auxiliarybar.pinnedPanels';
	static readonly placeholdeViewContainersKey = 'workbench.auxiliarybar.placeholderPanels';
	static readonly viewContainersWorkspaceStateKey = 'workbench.auxiliarybar.viewContainersWorkspaceState';

	/** Chat starts hidden on the Secondary Side Bar's rail; Source Control is the default view container there. */
	static readonly unpinnedByDefault: readonly string[] = ['workbench.panel.chat'];

	// Use the side bar dimensions
	override readonly minimumWidth: number = 170;
	override readonly maximumWidth: number = Number.POSITIVE_INFINITY;
	override readonly minimumHeight: number = 0;
	override readonly maximumHeight: number = Number.POSITIVE_INFINITY;

	get preferredHeight(): number | undefined {
		// Don't worry about titlebar or statusbar visibility
		// The difference is minimal and keeps this function clean
		return this.layoutService.mainContainerDimension.height * 0.4;
	}

	get preferredWidth(): number | undefined {
		const activeComposite = this.getActivePaneComposite();

		if (!activeComposite) {
			return undefined;
		}

		const width = activeComposite.getOptimalWidth();
		if (typeof width !== 'number') {
			return undefined;
		}

		return Math.max(width, 300);
	}

	readonly priority = LayoutPriority.Low;

	private configuration: IAuxiliaryBarPartConfiguration;
	private readonly visibleViewContainersTracker: VisibleViewContainersTracker;

	/**
	 * The vertical secondary activity bar on the outer edge of this part. It shares the pinned
	 * view container state with the composite bar this part renders in its title, header or
	 * footer, so switching positions keeps the same items.
	 */
	private readonly split = this._register(this.instantiationService.createInstance(PaneCompositeSplit, {
		host: this,
		hostPartId: Parts.AUXILIARYBAR_PART,
		partId: Parts.AUXILIARYBAR_BOTTOM_PART,
		location: ViewContainerLocation.AuxiliaryBar,
		registryId: Extensions.Auxiliary,
		storagePrefix: 'workbench.auxiliarybar.bottom',
		activeContext: ActiveAuxiliaryBottomContext,
		focusContext: AuxiliaryBarBottomFocusContext,
		titleMenuId: MenuId.AuxiliaryBarBottomTitle,
		partContainerClass: 'auxiliarybar',
		showCompositeBar: () => this.shouldShowCompositeBar(), // the bottom half shows its items in its title when the rail does not
		defaultBottomViewContainers: ['workbench.view.extensions'] // Extensions start at the bottom, above Manage
	}));

	readonly onDidBottomPaneCompositeOpen: Event<IPaneComposite> = this.split.onDidBottomPaneCompositeOpen;
	readonly onDidBottomPaneCompositeClose: Event<IPaneComposite> = this.split.onDidBottomPaneCompositeClose;

	private readonly activityBarPart = this._register(this.instantiationService.createInstance(ActivitybarPart, this.location, this, {
		partId: Parts.AUXILIARY_ACTIVITYBAR_PART,
		pinnedViewContainersKey: AuxiliaryBarPart.pinnedViewsKey,
		placeholderViewContainersKey: AuxiliaryBarPart.placeholdeViewContainersKey,
		viewContainersWorkspaceStateKey: AuxiliaryBarPart.viewContainersWorkspaceStateKey,
		unpinnedByDefault: AuxiliaryBarPart.unpinnedByDefault,
		split: {
			bottomPart: this.split.bottomPart,
			topFilter: this.split.topFilter,
			bottomFilter: this.split.bottomFilter,
			bottomPinnedViewContainersKey: this.split.bottomPinnedViewContainersKey,
			bottomPlaceholderViewContainersKey: this.split.bottomPlaceholderViewContainersKey,
			bottomViewContainersWorkspaceStateKey: this.split.bottomViewContainersWorkspaceStateKey,
			getMoveActions: id => this.split.getMoveActions(id)
		}
	}));

	constructor(
		@INotificationService notificationService: INotificationService,
		@IStorageService storageService: IStorageService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
		@IKeybindingService keybindingService: IKeybindingService,
		@IHoverService hoverService: IHoverService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IThemeService themeService: IThemeService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IExtensionService extensionService: IExtensionService,
		@ICommandService private commandService: ICommandService,
		@IMenuService menuService: IMenuService,
		@IConfigurationService configurationService: IConfigurationService
	) {
		super(
			Parts.AUXILIARYBAR_PART,
			{
				hasTitle: true,
				trailingSeparator: true,
				borderWidth: () => (this.getColor(SIDE_BAR_BORDER) || this.getColor(contrastBorder)) ? 1 : 0,
			},
			AuxiliaryBarPart.activeViewSettingsKey,
			ActiveAuxiliaryContext.bindTo(contextKeyService),
			AuxiliaryBarFocusContext.bindTo(contextKeyService),
			'auxiliarybar',
			'auxiliarybar',
			undefined,
			SIDE_BAR_TITLE_BORDER,
			ViewContainerLocation.AuxiliaryBar,
			Extensions.Auxiliary,
			MenuId.AuxiliaryBarTitle,
			notificationService,
			storageService,
			contextMenuService,
			layoutService,
			keybindingService,
			hoverService,
			instantiationService,
			themeService,
			viewDescriptorService,
			contextKeyService,
			extensionService,
			menuService,
			configurationService,
		);

		// Track visible view containers for auto-hide
		this.visibleViewContainersTracker = this._register(instantiationService.createInstance(VisibleViewContainersTracker, ViewContainerLocation.AuxiliaryBar));
		this._register(this.visibleViewContainersTracker.onDidChange((e) => this.onDidChangeAutoHideViewContainers(e)));

		this.configuration = this.resolveConfiguration();
		this.rememberActivityBarVisiblePosition();

		this._register(configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(LayoutSettings.AUXILIARY_ACTIVITY_BAR_LOCATION)) {
				this.configuration = this.resolveConfiguration();
				this.onDidChangeActivityBarLocation();
			} else if (e.affectsConfiguration('workbench.secondarySideBar.showLabels')) {
				this.configuration = this.resolveConfiguration();
				this.updateCompositeBar(true);
			} else if (e.affectsConfiguration(LayoutSettings.ACTIVITY_BAR_AUTO_HIDE)) {
				this.onDidChangeActivityBarLocation();
			}
		}));

		this.registerActions();
	}

	private onDidChangeAutoHideViewContainers(e: { before: number; after: number }): void {
		// Only update if auto-hide is enabled and composite bar would show
		const autoHide = this.configurationService.getValue<boolean>(LayoutSettings.ACTIVITY_BAR_AUTO_HIDE);
		if (autoHide && (this.configuration.position === AuxiliaryActivityBarPosition.TOP || this.configuration.position === AuxiliaryActivityBarPosition.BOTTOM)) {
			const visibleBefore = e.before > 1;
			const visibleAfter = e.after > 1;
			if (visibleBefore !== visibleAfter) {
				this.onDidChangeActivityBarLocation();
			}
		}
	}

	protected override getToolbarResponsiveBehavior(): IToolBarResponsiveBehaviorOptions {
		return {
			enabled: true,
			kind: 'all',
			minItems: 0,
			overflowFrom: 'start',
			actionMinWidth: 22,
			getActionMinWidth: action => action instanceof SubmenuItemAction && action.item.isSplitButton ? 36 : undefined,
		};
	}

	private resolveConfiguration(): IAuxiliaryBarPartConfiguration {
		const position = this.configurationService.getValue<AuxiliaryActivityBarPosition>(LayoutSettings.AUXILIARY_ACTIVITY_BAR_LOCATION) ?? AuxiliaryActivityBarPosition.DEFAULT;

		const canShowLabels = position === AuxiliaryActivityBarPosition.TITLE; // labels only fit in the title, the rail and the header/footer use icons
		const showLabels = canShowLabels && this.configurationService.getValue('workbench.secondarySideBar.showLabels') !== false;

		return { position, canShowLabels, showLabels };
	}

	private onDidChangeActivityBarLocation(): void {
		this.activityBarPart.hide();

		this.updateCompositeBar();

		const id = this.getActiveComposite()?.getId();
		if (id) {
			this.onTitleAreaUpdate(id);
		}

		if (this.shouldShowActivityBar()) {
			this.activityBarPart.show();
		}

		this.split.refreshCompositeBar();

		this.rememberActivityBarVisiblePosition();
	}

	protected override getSplit(): IPaneCompositeSplit {
		return this.split;
	}

	getBottomPaneComposite(): IPaneComposite | undefined {
		return this.split.getBottomPaneComposite();
	}

	hideBottomPaneComposite(): void {
		this.split.hideBottomPaneComposite();
	}

	override getProgressIndicator(id: string): IProgressIndicator | undefined {
		return super.getProgressIndicator(id) ?? this.split.bottomPart.getProgressIndicator(id);
	}

	private shouldShowActivityBar(): boolean {
		return this.configuration.position === AuxiliaryActivityBarPosition.DEFAULT;
	}

	private rememberActivityBarVisiblePosition(): void {
		if (this.configuration.position !== AuxiliaryActivityBarPosition.HIDDEN) {
			this.storageService.store(LayoutSettings.AUXILIARY_ACTIVITY_BAR_LOCATION, this.configuration.position, StorageScope.PROFILE, StorageTarget.USER);
		}
	}

	private getRememberedActivityBarVisiblePosition(): AuxiliaryActivityBarPosition {
		switch (this.storageService.get(LayoutSettings.AUXILIARY_ACTIVITY_BAR_LOCATION, StorageScope.PROFILE)) {
			case AuxiliaryActivityBarPosition.TITLE: return AuxiliaryActivityBarPosition.TITLE;
			case AuxiliaryActivityBarPosition.TOP: return AuxiliaryActivityBarPosition.TOP;
			case AuxiliaryActivityBarPosition.BOTTOM: return AuxiliaryActivityBarPosition.BOTTOM;
			default: return AuxiliaryActivityBarPosition.DEFAULT;
		}
	}

	override getPinnedPaneCompositeIds(): string[] {
		return this.shouldShowCompositeBar() ? super.getPinnedPaneCompositeIds() : this.activityBarPart.getPinnedPaneCompositeIds();
	}

	override getVisiblePaneCompositeIds(): string[] {
		return this.shouldShowCompositeBar() ? super.getVisiblePaneCompositeIds() : this.activityBarPart.getVisiblePaneCompositeIds();
	}

	override getPaneCompositeIds(): string[] {
		return this.shouldShowCompositeBar() ? super.getPaneCompositeIds() : this.activityBarPart.getPaneCompositeIds();
	}

	/**
	 * Focuses the secondary activity bar, showing it first if it is hidden.
	 */
	async focusActivityBar(): Promise<void> {
		if (this.configuration.position === AuxiliaryActivityBarPosition.HIDDEN) {
			await this.configurationService.updateValue(LayoutSettings.AUXILIARY_ACTIVITY_BAR_LOCATION, this.getRememberedActivityBarVisiblePosition());
			this.configuration = this.resolveConfiguration();
			this.onDidChangeActivityBarLocation();
		}

		if (this.shouldShowCompositeBar()) {
			this.focusCompositeBar();
		} else {
			if (!this.layoutService.isVisible(Parts.AUXILIARY_ACTIVITYBAR_PART)) {
				this.layoutService.setPartHidden(false, Parts.AUXILIARY_ACTIVITYBAR_PART);
			}

			this.activityBarPart.show(true);
		}
	}

	private registerActions(): void {
		const that = this;
		this._register(registerAction2(class extends Action2 {
			constructor() {
				super({
					id: ToggleSecondaryActivityBarVisibilityActionId,
					title: localize2('toggleSecondaryActivityBar', "Toggle Secondary Activity Bar Visibility"),
				});
			}
			run(): Promise<void> {
				const value = that.configuration.position === AuxiliaryActivityBarPosition.HIDDEN ? that.getRememberedActivityBarVisiblePosition() : AuxiliaryActivityBarPosition.HIDDEN;
				return that.configurationService.updateValue(LayoutSettings.AUXILIARY_ACTIVITY_BAR_LOCATION, value);
			}
		}));
	}

	override updateStyles(): void {
		super.updateStyles();

		const container = assertReturnsDefined(this.getContainer());
		container.style.backgroundColor = this.getColor(SIDE_BAR_BACKGROUND) || '';
		const borderColor = this.getColor(SIDE_BAR_BORDER) || this.getColor(contrastBorder);
		const isPositionLeft = this.layoutService.getSideBarPosition() === Position.RIGHT;

		container.style.color = this.getColor(SIDE_BAR_FOREGROUND) || '';

		container.style.borderLeftColor = borderColor ?? '';
		container.style.borderRightColor = borderColor ?? '';

		container.style.borderLeftStyle = borderColor && !isPositionLeft ? 'solid' : 'none';
		container.style.borderRightStyle = borderColor && isPositionLeft ? 'solid' : 'none';

		container.style.borderLeftWidth = borderColor && !isPositionLeft ? '1px' : '0px';
		container.style.borderRightWidth = borderColor && isPositionLeft ? '1px' : '0px';
	}

	protected getCompositeBarOptions(): IPaneCompositeBarOptions {
		const $this = this;
		return {
			partContainerClass: 'auxiliarybar',
			pinnedViewContainersKey: AuxiliaryBarPart.pinnedViewsKey,
			placeholderViewContainersKey: AuxiliaryBarPart.placeholdeViewContainersKey,
			viewContainersWorkspaceStateKey: AuxiliaryBarPart.viewContainersWorkspaceStateKey,
			unpinnedByDefault: AuxiliaryBarPart.unpinnedByDefault,
			filter: this.split.topFilter,
			transformContextMenuActionsForComposite: (actions, id) => [...actions, ...this.split.getMoveActions(id)],
			icon: !this.configuration.showLabels,
			orientation: ActionsOrientation.HORIZONTAL,
			recomputeSizes: true,
			activityHoverOptions: {
				position: () => this.getCompositeBarPosition() === CompositeBarPosition.BOTTOM ? HoverPosition.ABOVE : HoverPosition.BELOW,
			},
			fillExtraContextMenuActions: actions => this.fillExtraContextMenuActions(actions),
			compositeSize: 0,
			iconSize: 16,
			// Add 10px spacing if the overflow action is visible to no confuse the user with ... between the toolbars
			get overflowActionSize() { return $this.getCompositeBarPosition() === CompositeBarPosition.TITLE ? 40 : 30; },
			colors: theme => ({
				activeBackgroundColor: theme.getColor(SIDE_BAR_BACKGROUND),
				inactiveBackgroundColor: theme.getColor(SIDE_BAR_BACKGROUND),
				get activeBorderBottomColor() { return $this.getCompositeBarPosition() === CompositeBarPosition.TITLE ? theme.getColor(PANEL_ACTIVE_TITLE_BORDER) : theme.getColor(ACTIVITY_BAR_TOP_ACTIVE_BORDER); },
				get activeForegroundColor() { return $this.getCompositeBarPosition() === CompositeBarPosition.TITLE ? theme.getColor(PANEL_ACTIVE_TITLE_FOREGROUND) : theme.getColor(ACTIVITY_BAR_TOP_FOREGROUND); },
				get inactiveForegroundColor() { return $this.getCompositeBarPosition() === CompositeBarPosition.TITLE ? theme.getColor(PANEL_INACTIVE_TITLE_FOREGROUND) : theme.getColor(ACTIVITY_BAR_TOP_INACTIVE_FOREGROUND); },
				badgeBackground: theme.getColor(ACTIVITY_BAR_BADGE_BACKGROUND),
				badgeForeground: theme.getColor(ACTIVITY_BAR_BADGE_FOREGROUND),
				get dragAndDropBorder() { return $this.getCompositeBarPosition() === CompositeBarPosition.TITLE ? theme.getColor(PANEL_DRAG_AND_DROP_BORDER) : theme.getColor(ACTIVITY_BAR_TOP_DRAG_AND_DROP_BORDER); }
			}),
			compact: true
		};
	}

	private fillExtraContextMenuActions(actions: IAction[]): void {
		const currentPositionRight = this.layoutService.getSideBarPosition() === Position.LEFT;

		if (this.getCompositeBarPosition() === CompositeBarPosition.TITLE) {
			const viewsSubmenuAction = this.getViewsSubmenuAction();
			if (viewsSubmenuAction) {
				actions.push(new Separator());
				actions.push(viewsSubmenuAction);
			}
		}

		const activityBarPositionMenu = this.menuService.getMenuActions(MenuId.AuxiliaryActivityBarPositionMenu, this.contextKeyService, { shouldForwardArgs: true, renderShortTitle: true });
		const positionActions = getContextMenuActions(activityBarPositionMenu).secondary;

		const toggleShowLabelsAction = toAction({
			id: 'workbench.action.auxiliarybar.toggleShowLabels',
			label: this.configuration.showLabels ? localize('showIcons', "Show Icons") : localize('showLabels', "Show Labels"),
			enabled: this.configuration.canShowLabels,
			run: () => this.configurationService.updateValue('workbench.secondarySideBar.showLabels', !this.configuration.showLabels)
		});

		actions.push(...[
			new Separator(),
			new SubmenuAction('workbench.action.auxiliaryActivityBar.position', localize('secondary activity bar position', "Secondary Activity Bar Position"), positionActions),
			toAction({ id: ToggleSidebarPositionAction.ID, label: currentPositionRight ? localize('move second side bar left', "Move Secondary Side Bar Left") : localize('move second side bar right', "Move Secondary Side Bar Right"), run: () => this.commandService.executeCommand(ToggleSidebarPositionAction.ID) }),
			toggleShowLabelsAction,
			toAction({ id: ToggleAuxiliaryBarAction.ID, label: localize('hide second side bar', "Hide Secondary Side Bar"), run: () => this.commandService.executeCommand(ToggleAuxiliaryBarAction.ID) })
		]);
	}

	protected shouldShowCompositeBar(): boolean {
		if (this.configuration.position === AuxiliaryActivityBarPosition.HIDDEN) {
			return false;
		}

		// In the default position the items live in the vertical secondary activity bar
		if (this.configuration.position === AuxiliaryActivityBarPosition.DEFAULT) {
			return false;
		}

		// Check if auto-hide is enabled and there's only one visible view container
		// while the activity bar is configured to be top or bottom.
		if (this.configuration.position === AuxiliaryActivityBarPosition.TOP || this.configuration.position === AuxiliaryActivityBarPosition.BOTTOM) {
			const autoHide = this.configurationService.getValue<boolean>(LayoutSettings.ACTIVITY_BAR_AUTO_HIDE);
			if (autoHide) {
				// Use visible composite count from the composite bar if available (considers pinned state),
				// otherwise fall back to the tracker's count (based on active view descriptors).
				// Note: We access paneCompositeBar directly to avoid circular calls with getVisiblePaneCompositeIds()
				const visibleCount = this.visibleViewContainersTracker.visibleCount;
				if (visibleCount <= 1) {
					return false;
				}
			}
		}

		return true;
	}

	protected getCompositeBarPosition(): CompositeBarPosition {
		switch (this.configuration.position) {
			case AuxiliaryActivityBarPosition.TOP: return CompositeBarPosition.TOP;
			case AuxiliaryActivityBarPosition.BOTTOM: return CompositeBarPosition.BOTTOM;
			case AuxiliaryActivityBarPosition.TITLE:
			case AuxiliaryActivityBarPosition.HIDDEN:
			case AuxiliaryActivityBarPosition.DEFAULT: // noop
			default: return CompositeBarPosition.TITLE;
		}
	}

	override toJSON(): object {
		return {
			type: Parts.AUXILIARYBAR_PART
		};
	}
}
