/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../base/common/event.js';
import { assertReturnsDefined } from '../../../base/common/types.js';
import { InstantiationType, registerSingleton } from '../../../platform/instantiation/common/extensions.js';
import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { IProgressIndicator } from '../../../platform/progress/common/progress.js';
import { PaneCompositeDescriptor } from '../panecomposite.js';
import { AuxiliaryBarPart } from './auxiliarybar/auxiliaryBarPart.js';
import { PanelPart } from './panel/panelPart.js';
import { SidebarPart } from './sidebar/sidebarPart.js';
import { IPaneComposite } from '../../common/panecomposite.js';
import { ViewContainerLocation } from '../../common/views.js';
import { IPaneCompositePartService } from '../../services/panecomposite/browser/panecomposite.js';
import { Disposable, DisposableStore } from '../../../base/common/lifecycle.js';
import { IPaneCompositePart } from './paneCompositePart.js';
import { SINGLE_WINDOW_PARTS } from '../../services/layout/browser/layoutService.js';
import { coalesce } from '../../../base/common/arrays.js';

export class PaneCompositePartService extends Disposable implements IPaneCompositePartService {

	declare readonly _serviceBrand: undefined;

	readonly onDidPaneCompositeOpen: Event<{ composite: IPaneComposite; viewContainerLocation: ViewContainerLocation }>;
	readonly onDidPaneCompositeClose: Event<{ composite: IPaneComposite; viewContainerLocation: ViewContainerLocation }>;

	private readonly paneCompositeParts = new Map<ViewContainerLocation, IPaneCompositePart>();

	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();

		const panelPart = instantiationService.createInstance(PanelPart);
		const sideBarPart = instantiationService.createInstance(SidebarPart);
		const auxiliaryBarPart = instantiationService.createInstance(AuxiliaryBarPart);

		this.paneCompositeParts.set(ViewContainerLocation.Panel, panelPart);
		this.paneCompositeParts.set(ViewContainerLocation.Sidebar, sideBarPart);
		this.paneCompositeParts.set(ViewContainerLocation.AuxiliaryBar, auxiliaryBarPart);

		const viewContainerLocations = [ViewContainerLocation.Sidebar, ViewContainerLocation.Panel, ViewContainerLocation.AuxiliaryBar];

		// Include the bottom half of split side bars, whose view containers are visible too
		const eventDisposables = this._register(new DisposableStore());
		const openEvents = viewContainerLocations.flatMap(loc => {
			const part = this.paneCompositeParts.get(loc)!;
			return coalesce([part.onDidPaneCompositeOpen, part.onDidBottomPaneCompositeOpen]).map(event => Event.map(event, composite => { return { composite, viewContainerLocation: loc }; }, eventDisposables));
		});
		const closeEvents = viewContainerLocations.flatMap(loc => {
			const part = this.paneCompositeParts.get(loc)!;
			return coalesce([part.onDidPaneCompositeClose, part.onDidBottomPaneCompositeClose]).map(event => Event.map(event, composite => { return { composite, viewContainerLocation: loc }; }, eventDisposables));
		});
		this.onDidPaneCompositeOpen = Event.any(...openEvents);
		this.onDidPaneCompositeClose = Event.any(...closeEvents);
	}

	getRegistryId(viewContainerLocation: ViewContainerLocation): string {
		return this.getPartByLocation(viewContainerLocation).registryId;
	}

	getPartId(viewContainerLocation: ViewContainerLocation): SINGLE_WINDOW_PARTS {
		return this.getPartByLocation(viewContainerLocation).partId;
	}

	openPaneComposite(id: string | undefined, viewContainerLocation: ViewContainerLocation, focus?: boolean): Promise<IPaneComposite | undefined> {
		return this.getPartByLocation(viewContainerLocation).openPaneComposite(id, focus);
	}

	getActivePaneComposite(viewContainerLocation: ViewContainerLocation): IPaneComposite | undefined {
		return this.getPartByLocation(viewContainerLocation).getActivePaneComposite();
	}

	getPaneComposite(id: string, viewContainerLocation: ViewContainerLocation): PaneCompositeDescriptor | undefined {
		return this.getPartByLocation(viewContainerLocation).getPaneComposite(id);
	}

	getPaneComposites(viewContainerLocation: ViewContainerLocation): PaneCompositeDescriptor[] {
		return this.getPartByLocation(viewContainerLocation).getPaneComposites();
	}

	getPinnedPaneCompositeIds(viewContainerLocation: ViewContainerLocation): string[] {
		return this.getPartByLocation(viewContainerLocation).getPinnedPaneCompositeIds();
	}

	getVisiblePaneCompositeIds(viewContainerLocation: ViewContainerLocation): string[] {
		return this.getPartByLocation(viewContainerLocation).getVisiblePaneCompositeIds();
	}

	getPaneCompositeIds(viewContainerLocation: ViewContainerLocation): string[] {
		return this.getPartByLocation(viewContainerLocation).getPaneCompositeIds();
	}

	getProgressIndicator(id: string, viewContainerLocation: ViewContainerLocation): IProgressIndicator | undefined {
		return this.getPartByLocation(viewContainerLocation).getProgressIndicator(id);
	}

	hideActivePaneComposite(viewContainerLocation: ViewContainerLocation): void {
		this.getPartByLocation(viewContainerLocation).hideActivePaneComposite();
	}

	getLastActivePaneCompositeId(viewContainerLocation: ViewContainerLocation): string {
		return this.getPartByLocation(viewContainerLocation).getLastActivePaneCompositeId();
	}

	getBottomPaneComposite(viewContainerLocation: ViewContainerLocation): IPaneComposite | undefined {
		return this.getPartByLocation(viewContainerLocation).getBottomPaneComposite?.();
	}

	hideBottomPaneComposite(viewContainerLocation: ViewContainerLocation): void {
		this.getPartByLocation(viewContainerLocation).hideBottomPaneComposite?.();
	}

	resetViewContainerLayout(): void {
		for (const part of this.paneCompositeParts.values()) {
			part.resetViewContainerLayout?.();
		}
	}

	closeTopPaneComposite(viewContainerLocation: ViewContainerLocation): boolean {
		return this.getPartByLocation(viewContainerLocation).closeTopPaneComposite?.() ?? false;
	}

	private getPartByLocation(viewContainerLocation: ViewContainerLocation): IPaneCompositePart {
		return assertReturnsDefined(this.paneCompositeParts.get(viewContainerLocation));
	}

}

registerSingleton(IPaneCompositePartService, PaneCompositePartService, InstantiationType.Delayed);
