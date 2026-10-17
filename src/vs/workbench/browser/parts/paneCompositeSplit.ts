/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/paneCompositeSplit.css';
import { $, append, getWindow, scheduleAtNextAnimationFrame, size } from '../../../base/browser/dom.js';
import { ActionsOrientation } from '../../../base/browser/ui/actionbar/actionbar.js';
import { HoverPosition } from '../../../base/browser/ui/hover/hoverWidget.js';
import { IHorizontalSashLayoutProvider, Orientation, Sash, SashState } from '../../../base/browser/ui/sash/sash.js';
import { IAction, Separator, toAction } from '../../../base/common/actions.js';
import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable, MutableDisposable } from '../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../nls.js';
import { Action2, IMenuService, MenuId, registerAction2 } from '../../../platform/actions/common/actions.js';
import { Codicon } from '../../../base/common/codicons.js';
import { Categories } from '../../../platform/action/common/actionCommonCategories.js';
import { IPaneCompositePartService } from '../../services/panecomposite/browser/panecomposite.js';
import { ActiveAuxiliaryBottomContext, ActiveViewletBottomContext } from '../../common/contextkeys.js';
import { IConfigurationService } from '../../../platform/configuration/common/configuration.js';
import { IContextKeyService, RawContextKey } from '../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../platform/hover/browser/hover.js';
import { IInstantiationService, ServicesAccessor } from '../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../platform/keybinding/common/keybinding.js';
import { INotificationService } from '../../../platform/notification/common/notification.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../platform/theme/common/themeService.js';
import { IPaneComposite } from '../../common/panecomposite.js';
import { PANEL_ACTIVE_TITLE_BORDER, PANEL_ACTIVE_TITLE_FOREGROUND, PANEL_DRAG_AND_DROP_BORDER, PANEL_INACTIVE_TITLE_FOREGROUND, ACTIVITY_BAR_BADGE_BACKGROUND, ACTIVITY_BAR_BADGE_FOREGROUND, SIDE_BAR_BACKGROUND, SIDE_BAR_FOREGROUND, SIDE_BAR_TITLE_BORDER, SIDE_BAR_TITLE_FOREGROUND } from '../../common/theme.js';
import { IViewDescriptorService, ViewContainerLocation } from '../../common/views.js';
import { IExtensionService } from '../../services/extensions/common/extensions.js';
import { IWorkbenchLayoutService, Parts } from '../../services/layout/browser/layoutService.js';
import { PaneComposite, PaneCompositeDescriptor } from '../panecomposite.js';
import { IPaneCompositeBarFilter, IPaneCompositeBarOptions } from './paneCompositeBar.js';
import { AbstractPaneCompositePart, CompositeBarPosition, IPaneCompositeSplit } from './paneCompositePart.js';

/**
 * The height of the bottom half of a split side bar of the given total height. Each half keeps
 * at least the minimum height while there is room for both; otherwise they share it equally.
 */
export function getBottomPaneHeight(totalHeight: number, ratio: number, minimumPaneHeight: number): number {
	if (totalHeight < 2 * minimumPaneHeight) {
		return Math.floor(totalHeight / 2);
	}

	return Math.min(Math.max(Math.round(totalHeight * ratio), minimumPaneHeight), totalHeight - minimumPaneHeight);
}

/**
 * Remembers which view containers of one location live in the bottom half of its side bar.
 * Every other view container of that location lives in the top half. Stored per profile.
 */
export class PaneCompositeSlots extends Disposable {

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	private bottom: ReadonlySet<string>;

	constructor(
		private readonly location: ViewContainerLocation,
		private readonly storageKey: string,
		@IStorageService private readonly storageService: IStorageService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
	) {
		super();

		this.bottom = this.load();

		this._register(this.storageService.onDidChangeValue(StorageScope.PROFILE, this.storageKey, this._store)(() => this.update(this.load())));

		// A view container that leaves this location also leaves its slot, so it returns to the
		// top half when it comes back.
		this._register(viewDescriptorService.onDidChangeContainerLocation(({ viewContainer, from }) => {
			if (from === this.location) {
				this.setInBottom(viewContainer.id, false);
			}
		}));
	}

	isInBottom(viewContainerId: string): boolean {
		return this.bottom.has(viewContainerId);
	}

	setInBottom(viewContainerId: string, inBottom: boolean): void {
		if (this.isInBottom(viewContainerId) === inBottom) {
			return;
		}

		const bottom = new Set(this.bottom);
		if (inBottom) {
			bottom.add(viewContainerId);
		} else {
			bottom.delete(viewContainerId);
		}

		this.storageService.store(this.storageKey, JSON.stringify([...bottom]), StorageScope.PROFILE, StorageTarget.USER);
		this.update(bottom);
	}

	private update(bottom: ReadonlySet<string>): void {
		if (bottom.size === this.bottom.size && [...bottom].every(id => this.bottom.has(id))) {
			return;
		}

		this.bottom = bottom;
		this._onDidChange.fire();
	}

	private load(): ReadonlySet<string> {
		try {
			const value: unknown = JSON.parse(this.storageService.get(this.storageKey, StorageScope.PROFILE, '[]'));
			return new Set(Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : []);
		} catch {
			return new Set();
		}
	}
}

interface IBottomPaneCompositePartOptions {
	readonly partId: Parts.SIDEBAR_BOTTOM_PART | Parts.AUXILIARYBAR_BOTTOM_PART;
	readonly location: ViewContainerLocation;
	readonly registryId: string;
	readonly activeViewSettingsKey: string;
	readonly activeContext: RawContextKey<string>;
	readonly focusContext: RawContextKey<boolean>;
	readonly titleMenuId: MenuId;
	readonly partContainerClass: string;
	readonly compositeBarOptions: () => Pick<IPaneCompositeBarOptions, 'pinnedViewContainersKey' | 'placeholderViewContainersKey' | 'viewContainersWorkspaceStateKey' | 'filter' | 'transformContextMenuActionsForComposite'>;
	readonly showCompositeBar: () => boolean;

	/** Whether the view container belongs to the bottom half. */
	readonly isInBottom: (viewContainerId: string) => boolean;

	/** Opens a view container that does not belong to the bottom half in the hosting side bar. */
	readonly openInHost: (viewContainerId: string, focus?: boolean) => Promise<PaneComposite | undefined>;

	/** Prepares opening a view container in the bottom half, e.g. by showing the hosting side bar. */
	readonly willOpen: (viewContainerId: string) => void;
}

/**
 * The bottom half of a split side bar. It is a full pane composite part, with its own title,
 * toolbar and empty state, but it lives inside the side bar that hosts it instead of in the
 * workbench grid, so the hosting part lays it out.
 */
export class BottomPaneCompositePart extends AbstractPaneCompositePart {

	readonly minimumWidth: number = 0;
	readonly maximumWidth: number = Number.POSITIVE_INFINITY;
	readonly minimumHeight: number = 0;
	readonly maximumHeight: number = Number.POSITIVE_INFINITY;

	constructor(
		private readonly bottomOptions: IBottomPaneCompositePartOptions,
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
		@IMenuService menuService: IMenuService,
		@IConfigurationService configurationService: IConfigurationService,
	) {
		super(
			bottomOptions.partId,
			{ hasTitle: true, borderWidth: () => 0 },
			bottomOptions.activeViewSettingsKey,
			bottomOptions.activeContext.bindTo(contextKeyService),
			bottomOptions.focusContext.bindTo(contextKeyService),
			'sideBarBottom',
			'viewlet',
			SIDE_BAR_TITLE_FOREGROUND,
			SIDE_BAR_TITLE_BORDER,
			bottomOptions.location,
			bottomOptions.registryId,
			bottomOptions.titleMenuId,
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
	}

	protected override isEmbedded(): boolean {
		return true;
	}

	override async openPaneComposite(id?: string, focus?: boolean): Promise<PaneComposite | undefined> {
		if (typeof id === 'string') {
			if (!this.bottomOptions.isInBottom(id)) {
				return this.bottomOptions.openInHost(id, focus);
			}

			this.bottomOptions.willOpen(id);
		}

		return super.openPaneComposite(id, focus);
	}

	protected override onDidDeregisterPaneComposite(descriptor: PaneCompositeDescriptor): void {
		// Leave the bottom half closed instead of opening another view container in it
		if (this.getActivePaneComposite()?.getId() === descriptor.id) {
			this.hideActiveComposite();
		}
	}

	/**
	 * Re-evaluates whether this part shows its own composite bar, which it does only while
	 * no vertical activity bar shows the bottom half's view containers.
	 */
	refreshCompositeBar(): void {
		this.updateCompositeBar();
	}

	override updateStyles(): void {
		super.updateStyles();

		const container = this.getContainer();
		if (!container) {
			return;
		}

		container.style.backgroundColor = this.getColor(SIDE_BAR_BACKGROUND) || '';
		container.style.color = this.getColor(SIDE_BAR_FOREGROUND) || '';
	}

	protected shouldShowCompositeBar(): boolean {
		return this.bottomOptions.showCompositeBar();
	}

	protected getCompositeBarPosition(): CompositeBarPosition {
		return CompositeBarPosition.TITLE;
	}

	protected getCompositeBarOptions(): IPaneCompositeBarOptions {
		return {
			...this.bottomOptions.compositeBarOptions(),
			partContainerClass: this.bottomOptions.partContainerClass,
			icon: true,
			orientation: ActionsOrientation.HORIZONTAL,
			recomputeSizes: true,
			activityHoverOptions: {
				position: () => HoverPosition.BELOW,
			},
			fillExtraContextMenuActions: () => { },
			compositeSize: 0,
			iconSize: 16,
			overflowActionSize: 30,
			colors: theme => ({
				activeBackgroundColor: theme.getColor(SIDE_BAR_BACKGROUND),
				inactiveBackgroundColor: theme.getColor(SIDE_BAR_BACKGROUND),
				activeBorderBottomColor: theme.getColor(PANEL_ACTIVE_TITLE_BORDER),
				activeForegroundColor: theme.getColor(PANEL_ACTIVE_TITLE_FOREGROUND),
				inactiveForegroundColor: theme.getColor(PANEL_INACTIVE_TITLE_FOREGROUND),
				badgeBackground: theme.getColor(ACTIVITY_BAR_BADGE_BACKGROUND),
				badgeForeground: theme.getColor(ACTIVITY_BAR_BADGE_FOREGROUND),
				dragAndDropBorder: theme.getColor(PANEL_DRAG_AND_DROP_BORDER)
			}),
			compact: true
		};
	}

	toJSON(): object {
		return {
			type: this.bottomOptions.partId
		};
	}
}

export interface IPaneCompositeSplitOptions {

	/**
	 * The side bar that hosts the bottom half.
	 */
	readonly host: AbstractPaneCompositePart;
	readonly hostPartId: Parts.SIDEBAR_PART | Parts.AUXILIARYBAR_PART;
	readonly partId: Parts.SIDEBAR_BOTTOM_PART | Parts.AUXILIARYBAR_BOTTOM_PART;
	readonly location: ViewContainerLocation;
	readonly registryId: string;

	/**
	 * Prefix of every storage key the split uses.
	 */
	readonly storagePrefix: string;
	readonly activeContext: RawContextKey<string>;
	readonly focusContext: RawContextKey<boolean>;
	readonly titleMenuId: MenuId;
	readonly partContainerClass: string;

	/**
	 * Whether the bottom half shows its own composite bar, because no vertical activity bar
	 * shows its view containers.
	 */
	readonly showCompositeBar: () => boolean;
}

/**
 * Splits a side bar into a top and a bottom half that each show one view container, with a
 * sash between them to resize the halves. View containers are assigned to a half by
 * {@link PaneCompositeSlots}; the side bar itself remains a single part of the workbench grid.
 */
export class PaneCompositeSplit extends Disposable implements IPaneCompositeSplit, IHorizontalSashLayoutProvider {

	private static readonly MINIMUM_PANE_HEIGHT = 100;
	private static readonly DEFAULT_RATIO = 0.5;

	readonly slots: PaneCompositeSlots;
	readonly bottomPart: BottomPaneCompositePart;

	/**
	 * Shows the view containers of the top half, for the composite bars of the top half.
	 */
	readonly topFilter: IPaneCompositeBarFilter;

	/**
	 * Shows the view containers of the bottom half, for the composite bars of the bottom half.
	 */
	readonly bottomFilter: IPaneCompositeBarFilter;

	/**
	 * Storage keys for the composite bars that show the bottom half's view containers.
	 */
	readonly bottomPinnedViewContainersKey: string;
	readonly bottomPlaceholderViewContainersKey: string;
	readonly bottomViewContainersWorkspaceStateKey: string;

	private readonly ratioStorageKey: string;
	private readonly openStorageKey: string;

	private readonly _onDidChangeTopFilter = this._register(new Emitter<void>());

	private ratio: number;
	private wrapper: HTMLElement | undefined;
	private host: HTMLElement | undefined;
	private sash: Sash | undefined;
	private readonly sashLayout = this._register(new MutableDisposable());
	private lastTotalHeight = 0;
	private lastBottomHeight = 0;
	private sashStartBottomHeight = 0;

	/**
	 * The view container closed in the bottom half while the hosting side bar was hidden,
	 * reopened when the side bar shows again.
	 */
	private hiddenWithHost: string | undefined;

	constructor(
		private readonly options: IPaneCompositeSplitOptions,
		@IInstantiationService instantiationService: IInstantiationService,
		@IStorageService private readonly storageService: IStorageService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IViewDescriptorService private readonly viewDescriptorService: IViewDescriptorService,
	) {
		super();

		this.slots = this._register(instantiationService.createInstance(PaneCompositeSlots, options.location, `${options.storagePrefix}.viewContainers`));
		this.bottomPinnedViewContainersKey = `${options.storagePrefix}.pinnedViewContainers`;
		this.bottomPlaceholderViewContainersKey = `${options.storagePrefix}.placeholderViewContainers`;
		this.bottomViewContainersWorkspaceStateKey = `${options.storagePrefix}.viewContainersWorkspaceState`;
		this.ratioStorageKey = `${options.storagePrefix}.ratio`;
		this.openStorageKey = `${options.storagePrefix}.open`;
		this.ratio = this.loadRatio();

		this.topFilter = {
			// Without a vertical rail, the hosting side bar's own composite bar also offers the
			// bottom half's view containers while the bottom half is closed, so they stay reachable.
			includes: id => !this.slots.isInBottom(id) || (this.options.showCompositeBar() && !this.isOpen()),
			include: id => this.moveViewContainer(id, false, false),
			onDidChange: this._onDidChangeTopFilter.event
		};
		this.bottomFilter = {
			includes: id => this.slots.isInBottom(id),
			include: id => this.moveViewContainer(id, true, false),
			onDidChange: this.slots.onDidChange
		};

		this.bottomPart = this._register(instantiationService.createInstance(BottomPaneCompositePart, {
			partId: options.partId,
			location: options.location,
			registryId: options.registryId,
			activeViewSettingsKey: `${options.storagePrefix}.activeViewContainer`,
			activeContext: options.activeContext,
			focusContext: options.focusContext,
			titleMenuId: options.titleMenuId,
			partContainerClass: options.partContainerClass,
			showCompositeBar: options.showCompositeBar,
			isInBottom: id => this.slots.isInBottom(id),
			openInHost: (id, focus) => this.options.host.openPaneComposite(id, focus),
			willOpen: id => this.willOpenInBottom(id),
			compositeBarOptions: () => ({
				pinnedViewContainersKey: this.bottomPinnedViewContainersKey,
				placeholderViewContainersKey: this.bottomPlaceholderViewContainersKey,
				viewContainersWorkspaceStateKey: this.bottomViewContainersWorkspaceStateKey,
				filter: this.bottomFilter,
				transformContextMenuActionsForComposite: (actions, id) => [...actions, ...this.getMoveActions(id)],
			}),
		}));

		this._register(this.slots.onDidChange(() => this.onDidChangeSlots()));
		this._register(this.bottomPart.onDidPaneCompositeOpen(composite => this.onDidChangeBottomPaneComposite(composite.getId())));
		this._register(this.bottomPart.onDidPaneCompositeClose(() => this.onDidChangeBottomPaneComposite(undefined)));
		this._register(this.layoutService.onDidChangePartVisibility(e => {
			if (e.partId === this.options.hostPartId) {
				this.onDidChangeHostVisibility(e.visible);
			}
		}));

		this.restore();
	}

	get onDidBottomPaneCompositeOpen(): Event<IPaneComposite> { return this.bottomPart.onDidPaneCompositeOpen; }
	get onDidBottomPaneCompositeClose(): Event<IPaneComposite> { return this.bottomPart.onDidPaneCompositeClose; }

	getBottomPaneComposite(): IPaneComposite | undefined {
		return this.bottomPart.getActivePaneComposite();
	}

	hideBottomPaneComposite(): void {
		this.bottomPart.hideActivePaneComposite();
	}

	isInBottom(viewContainerId: string): boolean {
		return this.slots.isInBottom(viewContainerId);
	}

	async openInBottom(viewContainerId: string, focus?: boolean): Promise<IPaneComposite | undefined> {
		const composite = await this.bottomPart.openPaneComposite(viewContainerId, focus);

		// Opening through the side bar, e.g. when restoring it, must not leave its top half empty
		this.ensureTopPaneComposite();

		return composite;
	}

	willOpenInTop(viewContainerId: string): void {
		// A view container is only ever instantiated in one half
		this.bottomPart.removePaneComposite(viewContainerId);
	}

	private willOpenInBottom(viewContainerId: string): void {
		// An explicit open replaces whatever the hidden side bar was going to restore
		this.hiddenWithHost = undefined;

		// A view container is only ever instantiated in one half
		this.options.host.removePaneComposite(viewContainerId);

		if (!this.layoutService.isVisible(this.options.hostPartId)) {
			this.layoutService.setPartHidden(false, this.options.hostPartId);
		}
	}

	/**
	 * Opens a view container in the top half when it has none, preferring the location's
	 * default view container. Does nothing while the side bar is hidden.
	 */
	private ensureTopPaneComposite(): void {
		const host = this.options.host;
		if (host.getActivePaneComposite() || !this.layoutService.isVisible(this.options.hostPartId)) {
			return;
		}

		const defaultId = this.viewDescriptorService.getDefaultViewContainer(this.options.location)?.id;
		const next = defaultId && !this.slots.isInBottom(defaultId) && host.getPaneComposite(defaultId)
			? defaultId
			: host.getVisiblePaneCompositeIds().find(id => !this.slots.isInBottom(id));
		if (next) {
			host.openPaneComposite(next);
		}
	}

	/**
	 * Keeps each half showing only its own view containers when the assignment changes, here
	 * or in another window of the same profile.
	 */
	private onDidChangeSlots(): void {
		const topId = this.options.host.getActivePaneComposite()?.getId();
		if (topId && this.slots.isInBottom(topId)) {
			this.options.host.removePaneComposite(topId);
			this.ensureTopPaneComposite();
		}

		const bottomId = this.bottomPart.getActivePaneComposite()?.getId();
		if (bottomId && !this.slots.isInBottom(bottomId)) {
			this.bottomPart.removePaneComposite(bottomId);
		}

		this._onDidChangeTopFilter.fire();
	}

	/**
	 * Moves a view container to the bottom or the top half.
	 *
	 * @param open whether to open the view container in its new half.
	 */
	moveViewContainer(viewContainerId: string, toBottom: boolean, open: boolean): void {
		if (this.slots.isInBottom(viewContainerId) === toBottom) {
			if (open) {
				this.options.host.openPaneComposite(viewContainerId, true);
			}
			return;
		}

		// Close it in its current half before the composite bars re-filter, so they do not
		// replace the closed item by opening another view container. The slot change then
		// refills the top half if it became empty (see onDidChangeSlots).
		if (toBottom) {
			this.options.host.removePaneComposite(viewContainerId);
		} else {
			this.bottomPart.removePaneComposite(viewContainerId);
		}
		this.slots.setInBottom(viewContainerId, toBottom);

		if (open) {
			this.options.host.openPaneComposite(viewContainerId, true);
		}
	}

	/**
	 * Context menu actions that move a view container to the other half.
	 */
	getMoveActions(viewContainerId: string): IAction[] {
		const inBottom = this.slots.isInBottom(viewContainerId);
		return [
			new Separator(),
			toAction({
				id: inBottom ? 'moveViewContainerToTopHalf' : 'moveViewContainerToBottomHalf',
				label: inBottom ? localize('moveToTopHalf', "Move to Top Half") : localize('moveToBottomHalf', "Move to Bottom Half"),
				run: () => this.moveViewContainer(viewContainerId, !inBottom, true)
			})
		];
	}

	/**
	 * Re-evaluates whether the bottom half shows its own composite bar.
	 */
	refreshCompositeBar(): void {
		this.bottomPart.refreshCompositeBar();
		this._onDidChangeTopFilter.fire();
	}

	create(contentArea: HTMLElement, host: HTMLElement): void {
		this.host = host;
		host.classList.add('pane-composite-split-host');

		this.wrapper = $('.pane-composite-split-bottom');
		contentArea.after(this.wrapper);

		const partContainer = append(this.wrapper, $('.part.split-bottom-part'));
		partContainer.id = this.options.partId;
		partContainer.setAttribute('role', 'none');
		this.bottomPart.create(partContainer);

		this.sash = this._register(new Sash(host, this, { orientation: Orientation.HORIZONTAL }));
		this._register(this.sash.addClass('pane-composite-split-sash'));
		this._register(this.sash.onDidStart(() => {
			this.sashStartBottomHeight = this.lastBottomHeight;
		}));
		this._register(this.sash.onDidChange(e => {
			if (this.lastTotalHeight > 0) {
				this.ratio = this.clampRatio((this.sashStartBottomHeight - (e.currentY - e.startY)) / this.lastTotalHeight);
				this.options.host.relayoutPart();
			}
		}));
		this._register(this.sash.onDidEnd(() => this.storeRatio()));
		this._register(this.sash.onDidReset(() => {
			this.ratio = PaneCompositeSplit.DEFAULT_RATIO;
			this.storeRatio();
			this.options.host.relayoutPart();
		}));

		this.updateVisibility();
	}

	layout(width: number, height: number): number {
		if (!this.wrapper || !this.isOpen()) {
			this.lastTotalHeight = 0;
			return height;
		}

		const bottomHeight = getBottomPaneHeight(height, this.ratio, PaneCompositeSplit.MINIMUM_PANE_HEIGHT);

		this.lastTotalHeight = height;
		this.lastBottomHeight = bottomHeight;

		size(this.wrapper, width, bottomHeight);
		this.bottomPart.layout(width, bottomHeight, 0, 0);

		// The sash sits on the top edge of the bottom half, which is only known once the
		// hosting part has laid out its own title and content above it.
		if (this.host) {
			this.sashLayout.value = scheduleAtNextAnimationFrame(getWindow(this.host), () => this.sash?.layout());
		}

		return height - bottomHeight;
	}

	getHorizontalSashTop(): number {
		return this.wrapper?.offsetTop ?? 0;
	}

	getHorizontalSashLeft(): number {
		return 0;
	}

	getHorizontalSashWidth(): number {
		return this.host?.clientWidth ?? 0;
	}

	private isOpen(): boolean {
		return !!this.bottomPart.getActivePaneComposite();
	}

	private onDidChangeBottomPaneComposite(openId: string | undefined): void {
		if (!this.hiddenWithHost) {
			if (openId) {
				this.storageService.store(this.openStorageKey, openId, StorageScope.WORKSPACE, StorageTarget.MACHINE);
			} else {
				this.storageService.remove(this.openStorageKey, StorageScope.WORKSPACE);
			}
		}

		this.updateVisibility();
		this.options.host.relayoutPart();
		this._onDidChangeTopFilter.fire();
	}

	private onDidChangeHostVisibility(visible: boolean): void {
		if (!visible) {
			// Close the bottom half with its side bar, so its views know they are not visible
			const active = this.bottomPart.getActivePaneComposite()?.getId();
			if (active) {
				this.hiddenWithHost = active;
				this.bottomPart.hideActivePaneComposite();
			}
		} else if (this.hiddenWithHost) {
			const id = this.hiddenWithHost;
			this.hiddenWithHost = undefined;
			if (this.slots.isInBottom(id) && !this.isOpen()) {
				this.openInBottom(id);
			}
		}
	}

	private updateVisibility(): void {
		const open = this.isOpen();
		if (this.wrapper) {
			this.wrapper.classList.toggle('visible', open);
		}
		if (this.sash) {
			this.sash.state = open ? SashState.Enabled : SashState.Disabled;
		}
	}

	private restore(): void {
		const openId = this.storageService.get(this.openStorageKey, StorageScope.WORKSPACE);
		if (!openId) {
			return;
		}

		this.layoutService.whenRestored.then(() => {
			if (this._store.isDisposed || !this.slots.isInBottom(openId) || this.isOpen()) {
				return;
			}

			if (this.layoutService.isVisible(this.options.hostPartId)) {
				this.openInBottom(openId);
			} else {
				this.hiddenWithHost = openId;
			}
		});
	}

	private loadRatio(): number {
		const value = Number(this.storageService.get(this.ratioStorageKey, StorageScope.PROFILE));
		return Number.isFinite(value) && value > 0 ? this.clampRatio(value) : PaneCompositeSplit.DEFAULT_RATIO;
	}

	private storeRatio(): void {
		this.storageService.store(this.ratioStorageKey, String(this.ratio), StorageScope.PROFILE, StorageTarget.MACHINE);
	}

	private clampRatio(ratio: number): number {
		return Math.min(Math.max(ratio, 0.1), 0.9);
	}
}

//#region Close the bottom half

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.closeSideBarBottom',
			title: localize2('closeSideBarBottom', "Close Bottom Half of Primary Side Bar"),
			category: Categories.View,
			icon: Codicon.close,
			precondition: ActiveViewletBottomContext.notEqualsTo(''),
			f1: true,
			menu: {
				id: MenuId.SidebarBottomTitle,
				group: 'navigation',
				order: 100
			}
		});
	}

	run(accessor: ServicesAccessor): void {
		accessor.get(IPaneCompositePartService).hideBottomPaneComposite(ViewContainerLocation.Sidebar);
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.closeAuxiliaryBarBottom',
			title: localize2('closeAuxiliaryBarBottom', "Close Bottom Half of Secondary Side Bar"),
			category: Categories.View,
			icon: Codicon.close,
			precondition: ActiveAuxiliaryBottomContext.notEqualsTo(''),
			f1: true,
			menu: {
				id: MenuId.AuxiliaryBarBottomTitle,
				group: 'navigation',
				order: 100
			}
		});
	}

	run(accessor: ServicesAccessor): void {
		accessor.get(IPaneCompositePartService).hideBottomPaneComposite(ViewContainerLocation.AuxiliaryBar);
	}
});

//#endregion
