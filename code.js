figma.showUI(__html__, { width: 500, height: 640, themeColors: true });
figma.ui.onmessage = async (msg) => {
    console.log('Main thread received message:', msg); // Critical log
    if (msg.type === 'get-selection-key') {
        const selection = figma.currentPage.selection;
        if (selection.length > 0) {
            const node = selection[0];
            let key = '';
            if (node.type === 'INSTANCE') {
                if (node.mainComponent) {
                    key = node.mainComponent.key;
                }
            }
            else if (node.type === 'COMPONENT' || node.type === 'COMPONENT_SET') {
                key = node.key;
            }
            if (key) {
                console.log('Sending selection-key for mappedType:', msg.mappedType, 'Key:', key);
                figma.ui.postMessage({ type: 'selection-key', key, mappedType: msg.mappedType });
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
        const { key, mappedType } = msg;
        console.log('Fetching properties for key:', key, 'mappedType:', mappedType);
        try {
            let component;
            // 1. Check selection
            const selection = figma.currentPage.selection;
            if (selection.length > 0) {
                const node = selection[0];
                let selectedOwner = null;
                if (node.type === 'INSTANCE')
                    selectedOwner = node.mainComponent;
                else if (node.type === 'COMPONENT' || node.type === 'COMPONENT_SET')
                    selectedOwner = node;
                if (selectedOwner && selectedOwner.key === key) {
                    component = selectedOwner;
                }
            }
            // 2. Import
            if (!component) {
                try {
                    console.log('Attempting to import component by key:', key);
                    component = await figma.importComponentByKeyAsync(key);
                }
                catch (e) {
                    console.log('Import failed, fallback to local search for key:', key);
                }
            }
            // 3. Search local
            if (!component) {
                for (const page of figma.root.children) {
                    const found = page.findOne(node => (node.type === 'COMPONENT' || node.type === 'COMPONENT_SET') && node.key === key);
                    if (found) {
                        component = found;
                        break;
                    }
                }
            }
            if (!component) {
                throw new Error('Component not found.');
            }
            let propertyOwner = component;
            if (component.type === 'COMPONENT' && component.parent && component.parent.type === 'COMPONENT_SET') {
                propertyOwner = component.parent;
            }

            const properties = propertyOwner.componentPropertyDefinitions;
            const propArray = Object.keys(properties)
                .filter(name => name.startsWith('#'))
                .map(name => ({
                    name,
                    path: name,
                    type: properties[name].type,
                    role: 'prop'
                }));

            const getNodePath = (node, root) => {
                const parts = [];
                let curr = node;
                while (curr) {
                    let name = curr.name;
                    const parent = curr.parent;
                    if (parent && parent.id !== root.id) {
                        const siblings = parent.children.filter((c) => c.name === name);
                        if (siblings.length > 1) {
                            const index = siblings.indexOf(curr);
                            if (index > 0)
                                name = `${name} [${index}]`;
                        }
                    }
                    parts.unshift(name);
                    if (curr.id === root.id)
                        break;
                    curr = curr.parent;
                }
                return parts.join(' > ');
            };

            const nestedElements = [];
            const scan = (node, root) => {
                if (node.name.startsWith('#')) {
                    nestedElements.push({
                        name: node.name,
                        path: getNodePath(node, root),
                        type: node.type,
                        role: 'layer'
                    });
                }
                if ('children' in node) {
                    for (const child of node.children)
                        scan(child, root);
                }
            };
            // Only scan the specific component/variant, even if it's in a set
            scan(component, component);
            nestedElements.forEach(layer => {
                propArray.push(layer);
            });
            console.log(`Sending properties-list for ${mappedType}. Fields found: ${propArray.length}`);
            figma.ui.postMessage({ type: 'properties-list', properties: propArray, mappedType, key });
        }
        catch (e) {
            figma.ui.postMessage({ type: 'error', message: e.message || 'Error fetching properties.' });
        }
    }
    if (msg.type === 'generate') {
        const { data, typeColumn, mapping } = msg;
        try {
            const nodes = [];
            const sectionFrames = new Map();
            console.log('Generation started. Rows:', data.length);
            for (const row of data) {
                const typeVal = row[typeColumn];
                const sectionName = row['section_name'] || 'General';
                const config = mapping[typeVal];
                if (!config || !config.componentKey) {
                    console.log('Skipping row - no config or key for type:', typeVal);
                    continue;
                }
                let component;
                try {
                    console.log('Requesting component for key:', config.componentKey);
                    component = await figma.importComponentByKeyAsync(config.componentKey);
                }
                catch (e) {
                    console.log('Library import failed, searching in local document...');
                    for (const page of figma.root.children) {
                        const found = page.findOne(node => (node.type === 'COMPONENT' || node.type === 'COMPONENT_SET') && node.key === config.componentKey);
                        if (found) {
                            component = found;
                            break;
                        }
                    }
                }
                if (!component) {
                    console.warn('Component NOT FOUND for key:', config.componentKey);
                    continue;
                }

                // Get or Create Section Frame
                let frame = sectionFrames.get(sectionName);
                if (!frame) {
                    frame = figma.createFrame();
                    frame.name = sectionName;
                    frame.layoutMode = 'VERTICAL';
                    frame.itemSpacing = 16;
                    frame.paddingTop = 24;
                    frame.paddingBottom = 24;
                    frame.paddingLeft = 24;
                    frame.paddingRight = 24;
                    frame.primaryAxisSizingMode = 'AUTO';
                    frame.counterAxisSizingMode = 'FIXED';
                    frame.resize(375, 100); // Initial height, will grow due to AUTO sizing
                    sectionFrames.set(sectionName, frame);
                    nodes.push(frame);
                }

                const instance = component.createInstance();
                console.log('Created instance for:', typeVal);
                frame.appendChild(instance);

                const propertiesToSet = {};
                let propertyOwner = component;
                if (component.type === 'COMPONENT' && component.parent && component.parent.type === 'COMPONENT_SET') {
                    propertyOwner = component.parent;
                }
                const fields = config.fields || {};
                for (const [targetKey, csvCol] of Object.entries(fields)) {
                    const value = row[csvCol];
                    if (value === undefined || value === "")
                        continue;
                    if (propertyOwner.componentPropertyDefinitions[targetKey]) {
                        const propDef = propertyOwner.componentPropertyDefinitions[targetKey];
                        let processedValue = value;
                        if (propDef.type === 'BOOLEAN') {
                            processedValue = (String(value).toLowerCase() === 'true' || value === '1' || String(value).toLowerCase() === 'si');
                        }
                        propertiesToSet[targetKey] = processedValue;
                    }
                    else {
                        const findByPath = (root, path) => {
                            const parts = path.split(' > ');
                            let current = root;
                            // Skip parts[0] because it's the root component name
                            for (let i = 1; i < parts.length; i++) {
                                if (!current || !current.children)
                                    return null;
                                let targetName = parts[i];
                                let targetIndex = 0;
                                // Check for index suffix like "Name [1]"
                                const match = targetName.match(/(.+) \[(\d+)\]$/);
                                if (match) {
                                    targetName = match[1];
                                    targetIndex = parseInt(match[2], 10);
                                }
                                const siblings = current.children.filter((c) => c.name === targetName);
                                current = siblings[targetIndex];
                            }
                            return current;
                        };
                        const targetNode = findByPath(instance, targetKey);
                        if (targetNode) {
                            const boolValues = ['true', 'false', '1', '0', 'si', 'no'];
                            const isBool = boolValues.includes(String(value).toLowerCase());
                            if (isBool) {
                                targetNode.visible = (String(value).toLowerCase() === 'true' || value === '1' || String(value).toLowerCase() === 'si');
                            }
                            else if (targetNode.type === 'TEXT') {
                                try {
                                    await figma.loadFontAsync(targetNode.fontName);
                                    targetNode.characters = String(value);
                                }
                                catch (err) {
                                    console.error('Font load error:', err);
                                }
                            }
                        }
                    }
                }
                try {
                    instance.setProperties(propertiesToSet);
                }
                catch (err) {
                    console.warn('setProperties error:', err);
                }
            }

            // Position frames horizontally
            let currentX = figma.viewport.center.x;
            for (const frame of Array.from(sectionFrames.values())) {
                frame.x = currentX;
                frame.y = figma.viewport.center.y - (frame.height / 2);
                currentX += frame.width + 100; // Spacing between sections
            }

            if (nodes.length > 0) {
                figma.currentPage.selection = nodes;
                figma.viewport.scrollAndZoomIntoView(nodes);
                figma.closePlugin('Generated ' + nodes.length + ' instances across ' + sectionFrames.size + ' sections!');
            }
            else {
                figma.ui.postMessage({ type: 'error', message: 'No instances generated. Check mappings.' });
            }
        }
        catch (e) {
            console.error('Generation overall error:', e);
            figma.ui.postMessage({ type: 'error', message: 'Error generating.' });
        }
    }
};
