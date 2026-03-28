figma.showUI(__html__, { width: 320, height: 480, themeColors: true });
figma.ui.onmessage = async (msg) => {
    if (msg.type === 'get-selection-key') {
        const selection = figma.currentPage.selection;
        if (selection.length > 0) {
            const node = selection[0];
            let key = '';
            if (node.type === 'INSTANCE') {
                key = node.mainComponent ? node.mainComponent.key : '';
            }
            else if (node.type === 'COMPONENT' || node.type === 'COMPONENT_SET') {
                key = node.key;
            }
            if (key) {
                figma.ui.postMessage({ type: 'selection-key', key });
            }
            else {
                figma.ui.postMessage({ type: 'error', message: 'Selected item has no Component Key.' });
            }
        }
        else {
            figma.ui.postMessage({ type: 'error', message: 'Please select a component or instance first.' });
        }
    }
    if (msg.type === 'get-properties') {
        const key = msg.key;
        console.log('Fetching properties for key:', key);
        try {
            let component;
            const selection = figma.currentPage.selection;
            if (selection.length > 0) {
                const node = selection[0];
                let selectedComponent = null;
                if (node.type === 'INSTANCE')
                    selectedComponent = node.mainComponent;
                else if (node.type === 'COMPONENT' || node.type === 'COMPONENT_SET')
                    selectedComponent = node;
                if (selectedComponent && selectedComponent.key === key) {
                    component = selectedComponent;
                    console.log('Using component from current selection:', component.name);
                }
            }
            if (!component) {
                try {
                    component = await figma.importComponentByKeyAsync(key);
                    console.log('Imported from library:', component.name);
                }
                catch (e) {
                    console.log('Import failed or component not accessible via key:', key);
                }
            }
            if (!component) {
                for (const page of figma.root.children) {
                    const found = page.findOne(node => (node.type === 'COMPONENT' || node.type === 'COMPONENT_SET') && node.key === key);
                    if (found) {
                        component = found;
                        console.log('Found local component:', component.name);
                        break;
                    }
                }
            }
            if (!component) {
                throw new Error('Component not found. Ensure the library is enabled or the component is public.');
            }
            let propertyOwner = component;
            if (component.type === 'COMPONENT' && component.parent && component.parent.type === 'COMPONENT_SET') {
                propertyOwner = component.parent;
            }
            const properties = propertyOwner.componentPropertyDefinitions;
            const propArray = Object.keys(properties).map(name => ({
                name,
                type: properties[name].type,
                role: 'prop'
            }));
            const nestedElements = new Map();
            const scan = (node) => {
                if (node.name.startsWith('#')) {
                    nestedElements.set(node.name, { name: node.name, type: node.type, role: 'layer' });
                }
                if ('children' in node) {
                    for (const child of node.children)
                        scan(child);
                }
            };
            if (propertyOwner.type === 'COMPONENT_SET') {
                propertyOwner.children.forEach(variant => scan(variant));
            }
            else {
                scan(propertyOwner);
            }
            nestedElements.forEach(layer => {
                if (!propArray.find(p => p.name === layer.name)) {
                    propArray.push(layer);
                }
            });
            figma.ui.postMessage({ type: 'properties-list', properties: propArray });
        }
        catch (e) {
            console.error(e);
            figma.ui.postMessage({ type: 'error', message: e.message || 'Error fetching component.' });
        }
    }
    if (msg.type === 'generate') {
        const { data, mappings, templateKey, typeToKeyMap } = msg;
        try {
            const nodes = [];
            let yOffset = 0;
            let keyColumn = '';
            let typeColumn = '';
            for (const [col, role] of Object.entries(mappings)) {
                if (role === 'comp-key')
                    keyColumn = col;
                if (role === 'comp-type')
                    typeColumn = col;
            }
            for (const row of data) {
                let rowKey = templateKey;
                if (typeColumn && typeToKeyMap) {
                    const typeVal = row[typeColumn];
                    if (typeToKeyMap[typeVal])
                        rowKey = typeToKeyMap[typeVal];
                }
                else if (keyColumn) {
                    rowKey = row[keyColumn];
                }
                if (!rowKey)
                    continue;
                let component;
                try {
                    component = await figma.importComponentByKeyAsync(rowKey);
                }
                catch (e) {
                    for (const page of figma.root.children) {
                        const found = page.findOne(node => (node.type === 'COMPONENT' || node.type === 'COMPONENT_SET') && node.key === rowKey);
                        if (found) {
                            component = found;
                            break;
                        }
                    }
                }
                if (!component) {
                    console.warn('Component not found for row key:', rowKey);
                    continue;
                }
                const instance = component.createInstance();
                const propertiesToSet = {};
                let propertyOwner = component;
                if (component.type === 'COMPONENT' && component.parent && component.parent.type === 'COMPONENT_SET') {
                    propertyOwner = component.parent;
                }
                for (const [col, role] of Object.entries(mappings)) {
                    const value = row[col];
                    if (value === undefined || value === "")
                        continue;
                    if (typeof role === 'string' && role.startsWith('prop:')) {
                        const propName = role.replace('prop:', '');
                        const propDef = propertyOwner.componentPropertyDefinitions[propName];
                        if (propDef) {
                            let processedValue = value;
                            if (propDef.type === 'BOOLEAN') {
                                processedValue = (value.toLowerCase() === 'true' || value === '1' || value.toLowerCase() === 'si');
                            }
                            propertiesToSet[propName] = processedValue;
                        }
                    }
                    else if (typeof role === 'string' && role.startsWith('layer:')) {
                        const layerName = role.replace('layer:', '');
                        const findAndApply = async (n) => {
                            if (n.name === layerName) {
                                const boolValues = ['true', 'false', '1', '0', 'si', 'no'];
                                const isBool = boolValues.indexOf(String(value).toLowerCase()) !== -1;
                                if (isBool) {
                                    n.visible = (String(value).toLowerCase() === 'true' || value === '1' || String(value).toLowerCase() === 'si');
                                }
                                else if (n.type === 'TEXT') {
                                    await figma.loadFontAsync(n.fontName);
                                    n.characters = String(value);
                                }
                                return true;
                            }
                            if ('children' in n) {
                                for (const child of n.children) {
                                    if (await findAndApply(child))
                                        return true;
                                }
                            }
                            return false;
                        };
                        await findAndApply(instance);
                    }
                }
                try {
                    instance.setProperties(propertiesToSet);
                }
                catch (err) {
                    console.error('Error setting properties:', err);
                }
                instance.x = figma.viewport.center.x;
                instance.y = figma.viewport.center.y + yOffset;
                yOffset += instance.height + 20;
                nodes.push(instance);
            }
            figma.currentPage.selection = nodes;
            figma.viewport.scrollAndZoomIntoView(nodes);
            figma.closePlugin('Generated ' + nodes.length + ' instances!');
        }
        catch (e) {
            figma.ui.postMessage({ type: 'error', message: 'Error generating instances.' });
        }
    }
};
