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
      } else if (node.type === 'COMPONENT' || node.type === 'COMPONENT_SET') {
        key = node.key;
      }

      if (key) {
        console.log('Sending selection-key for mappedType:', msg.mappedType, 'Key:', key);
        figma.ui.postMessage({ type: 'selection-key', key, mappedType: msg.mappedType });
      } else {
        figma.ui.postMessage({ type: 'error', message: 'Selected item has no Component Key.' });
      }
    } else {
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
        let selectedOwner: any = null;
        if (node.type === 'INSTANCE') selectedOwner = node.mainComponent;
        else if (node.type === 'COMPONENT' || node.type === 'COMPONENT_SET') selectedOwner = node;

        if (selectedOwner && (selectedOwner.key === key || (selectedOwner.parent && selectedOwner.parent.key === key))) {
          component = selectedOwner;
        }
      }

      // 2. Import
      if (!component) {
        try {
          component = await figma.importComponentByKeyAsync(key);
        } catch (e) { }
      }

      // 3. Search local
      if (!component) {
        for (const page of figma.root.children) {
          const found = page.findOne(node =>
            (node.type === 'COMPONENT' || node.type === 'COMPONENT_SET') && node.key === key
          );
          if (found) {
            component = found as ComponentNode | ComponentSetNode;
            break;
          }
        }
      }

      if (!component) {
        throw new Error('Component not found.');
      }

      let propertyOwner: ComponentNode | ComponentSetNode = component;
      if (component.type === 'COMPONENT' && component.parent && component.parent.type === 'COMPONENT_SET') {
        propertyOwner = component.parent as ComponentSetNode;
      }

      const properties = propertyOwner.componentPropertyDefinitions;
      const propArray = Object.keys(properties)
        .filter(name => name.startsWith('#'))
        .map(name => ({
          name,
          type: properties[name].type,
          role: 'prop'
        }));

      const getNodePath = (node: any, root: any): string => {
        const parts = [];
        let curr = node;
        while (curr) {
          let name = curr.name;
          const parent = curr.parent;
          if (parent && parent.id !== root.id) {
            const siblings = parent.children.filter((c: any) => c.name === name);
            if (siblings.length > 1) {
              const index = siblings.indexOf(curr);
              if (index > 0) name = `${name} [${index}]`;
            }
          }
          parts.unshift(name);
          if (curr.id === root.id) break;
          curr = curr.parent;
        }
        return parts.join(' > ');
      };

      const nestedElements: any[] = [];
      const scan = (node: any, root: any) => {
        if (node.name.startsWith('#')) {
          nestedElements.push({
            name: node.name,
            path: getNodePath(node, root),
            type: node.type,
            role: 'layer'
          });
        }
        if ('children' in node) {
          for (const child of node.children) scan(child, root);
        }
      };

      // Only scan the specific component/variant, even if it's in a set
      scan(component, component);

      nestedElements.forEach(layer => {
        // Now uniqueness is managed by the index [n]
        propArray.push(layer);
      });

      figma.ui.postMessage({ type: 'properties-list', properties: propArray, mappedType, key });
    } catch (e) {
      figma.ui.postMessage({ type: 'error', message: e.message || 'Error fetching properties.' });
    }
  }

  if (msg.type === 'generate') {
    const { data, typeColumn, mapping, images } = msg;

    try {
      const nodes: SceneNode[] = [];
      const sectionFrames = new Map<string, FrameNode>();

      // Populate image map for fast lookup
      const imageMap = new Map<string, Uint8Array>();
      if (images && Array.isArray(images)) {
        for (const img of images) {
          imageMap.set(img.name.toLowerCase().trim(), img.data);
        }
      }

      const getCleanFilename = (val: string): string => {
        if (!val) return '';
        let name = val.split('/').pop() || val;
        name = name.split('\\').pop() || name;
        name = name.split('?')[0];
        return name.toLowerCase().trim();
      };

      for (const row of data) {
        const typeVal = row[typeColumn];
        const sectionName = row['section_name'] || 'General';
        const config = mapping[typeVal];

        if (!config || !config.componentKey) {
          console.log('Skipping row - no config for type:', typeVal);
          continue;
        }

        let component;
        try {
          console.log('Attempting to import component for key:', config.componentKey);
          component = await figma.importComponentByKeyAsync(config.componentKey);
          console.log('Successfully imported library component:', component.name);
        } catch (e) {
          console.log('Library import failed, searching local pages for key:', config.componentKey);
          for (const page of figma.root.children) {
            const found = page.findOne(node =>
              (node.type === 'COMPONENT' || node.type === 'COMPONENT_SET') && node.key === config.componentKey
            );
            if (found) {
              component = found as ComponentNode | ComponentSetNode;
              console.log('Found local component:', component.name, 'on page:', page.name);
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
        console.log('Created instance for row type:', typeVal);
        frame.appendChild(instance);

        const propertiesToSet = {};

        let propertyOwner: ComponentNode | ComponentSetNode = component;
        if (component.type === 'COMPONENT' && component.parent && component.parent.type === 'COMPONENT_SET') {
          propertyOwner = component.parent as ComponentSetNode;
        }

        // Apply mappings for this type
        const fields = config.fields || {};
        console.log('Applying mappings:', fields);

        for (const [targetKey, csvCol] of Object.entries(fields)) {
          if (!csvCol) continue; // Skip if no column is mapped to this target
          
          const value = row[csvCol as string];
          if (value === undefined) continue;

          // targetKey is either a Prop Name or a Hierarchy Path

          // 1. Check if it's a property
          if (propertyOwner.componentPropertyDefinitions[targetKey]) {
            const propDef = propertyOwner.componentPropertyDefinitions[targetKey];
            let processedValue: any = value;
            if (propDef.type === 'BOOLEAN') {
              processedValue = (String(value).toLowerCase() === 'true' || value === '1' || String(value).toLowerCase() === 'si');
            }
            propertiesToSet[targetKey] = processedValue;
          } else {
            // 2. It's a layer path
            const findByPath = (root: any, path: string) => {
              const parts = path.split(' > ');
              let current = root;
              // Skip parts[0] because it's the root component name
              for (let i = 1; i < parts.length; i++) {
                if (!current || !current.children) return null;

                let targetName = parts[i];
                let targetIndex = 0;

                // Check for index suffix like "Name [1]"
                const match = targetName.match(/(.+) \[(\d+)\]$/);
                if (match) {
                  targetName = match[1];
                  targetIndex = parseInt(match[2], 10);
                }

                const siblings = current.children.filter((c: any) => c.name === targetName);
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
              } else if (targetNode.type === 'TEXT') {
                try {
                  await figma.loadFontAsync(targetNode.fontName as FontName);
                  targetNode.characters = String(value);
                } catch (err) {
                  console.error('Font load error:', err);
                }
              } else if ('fills' in targetNode) {
                const cleanVal = getCleanFilename(String(value));
                const imgData = imageMap.get(cleanVal);
                if (imgData) {
                  try {
                    const image = figma.createImage(imgData);
                    targetNode.fills = [{
                      type: 'IMAGE',
                      scaleMode: 'FILL',
                      imageHash: image.hash
                    }];
                  } catch (err) {
                    console.error('Error setting image fill:', err);
                  }
                }
              }
            } else {
              // Fallback to name search if path lookup fails (backward compatibility or minor changes)
              const findByName = (n: any): any => {
                if (n.name === targetKey) return n;
                if (n.children) {
                  for (const c of n.children) {
                    const found = findByName(c);
                    if (found) return found;
                  }
                }
                return null;
              };
              const fallbackNode = findByName(instance);
              if (fallbackNode) {
                if (fallbackNode.type === 'TEXT') {
                  await figma.loadFontAsync(fallbackNode.fontName as FontName);
                  fallbackNode.characters = String(value);
                } else if ('fills' in fallbackNode) {
                  const cleanVal = getCleanFilename(String(value));
                  const imgData = imageMap.get(cleanVal);
                  if (imgData) {
                    try {
                      const image = figma.createImage(imgData);
                      fallbackNode.fills = [{
                        type: 'IMAGE',
                        scaleMode: 'FILL',
                        imageHash: image.hash
                      }];
                    } catch (err) {
                      console.error('Error setting image fill in fallback:', err);
                    }
                  }
                }
              }
            }
          }
        }

        try {
          instance.setProperties(propertiesToSet);
        } catch (err) {
          console.warn('Set properties error (handled):', err);
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
    } catch (e) {
      console.error('Generation overall error:', e);
      figma.ui.postMessage({ type: 'error', message: 'Error generating.' });
    }
  }

  if (msg.type === 'save-mapping') {
    const { mapping } = msg;
    try {
      const existingMappingsJson = await figma.clientStorage.getAsync('saved_mappings') || '[]';
      const existingMappings = JSON.parse(existingMappingsJson);
      
      const index = existingMappings.findIndex((m: any) => m.id === mapping.id);
      if (index !== -1) {
        existingMappings[index] = mapping;
      } else {
        existingMappings.push(mapping);
      }
      
      await figma.clientStorage.setAsync('saved_mappings', JSON.stringify(existingMappings));
      const updatedMappings = await figma.clientStorage.getAsync('saved_mappings');
      figma.ui.postMessage({ type: 'mappings-list', mappings: JSON.parse(updatedMappings) });
    } catch (e) {
      figma.ui.postMessage({ type: 'error', message: 'Failed to save mapping.' });
    }
  }

  if (msg.type === 'get-mappings') {
    try {
      const mappingsJson = await figma.clientStorage.getAsync('saved_mappings') || '[]';
      figma.ui.postMessage({ type: 'mappings-list', mappings: JSON.parse(mappingsJson) });
    } catch (e) {
      figma.ui.postMessage({ type: 'error', message: 'Failed to load mappings.' });
    }
  }

  if (msg.type === 'delete-mapping') {
    const { id } = msg;
    try {
      const existingMappingsJson = await figma.clientStorage.getAsync('saved_mappings') || '[]';
      const existingMappings = JSON.parse(existingMappingsJson);
      const filtered = existingMappings.filter((m: any) => m.id !== id);
      await figma.clientStorage.setAsync('saved_mappings', JSON.stringify(filtered));
      figma.ui.postMessage({ type: 'mappings-list', mappings: filtered });
    } catch (e) {
      figma.ui.postMessage({ type: 'error', message: 'Failed to delete mapping.' });
    }
  }
}
