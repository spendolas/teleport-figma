// ── Types ────────────────────────────────────────────────────────────

interface SectionConfig {
  layout: 'horizontal' | 'vertical' | 'grid';
  columns: number;
  rows: number;
  masonry: boolean;
  hGap: number;
  vGap: number;
}

interface SectionInfo {
  id: string;
  name: string;
  config: SectionConfig | null;
}

const DEFAULT_CONFIG: SectionConfig = {
  layout: 'horizontal',
  columns: 3,
  rows: 0,
  masonry: false,
  hGap: 40,
  vGap: 200,
};

const SECTION_PADDING = 400;

// ── Helpers ──────────────────────────────────────────────────────────

function getPages(): Array<{ id: string; name: string; hasSections: boolean }> {
  return figma.root.children.map(p => ({
    id: p.id,
    name: p.name,
    hasSections: p.getPluginData('hasTeleportSections') === 'true',
  }));
}

async function getTeleportSections(pageId: string): Promise<SectionInfo[]> {
  const page = figma.root.children.find(p => p.id === pageId);
  if (!page) return [];
  await page.loadAsync();
  const sections = page.children
    .filter(n => n.type === 'SECTION' && n.getPluginData('teleport') === 'true')
    .map(n => {
      let config: SectionConfig | null = null;
      const raw = n.getPluginData('teleport-config');
      if (raw) {
        try { config = JSON.parse(raw); } catch (_e) { /* ignore */ }
      }
      return { id: n.id, name: n.name, config };
    });

  // Cache on page node for cheap lookup in getPages()
  page.setPluginData('hasTeleportSections', sections.length > 0 ? 'true' : 'false');

  return sections;
}

async function createTeleportSection(
  page: PageNode,
  name: string,
  config: SectionConfig
): Promise<SectionNode> {
  await page.loadAsync();
  const section = figma.createSection();
  section.name = name || 'Teleport';
  section.setPluginData('teleport', 'true');
  section.setPluginData('teleport-config', JSON.stringify(config));
  page.appendChild(section);

  // Position below existing content on the page
  let maxY = 0;
  for (const child of page.children) {
    if (child.id !== section.id && 'height' in child) {
      const bottom = child.y + child.height;
      if (bottom > maxY) maxY = bottom;
    }
  }
  section.y = maxY + 200;
  section.x = 0;
  section.resizeWithoutConstraints(100, 100);
  return section;
}

function updateSectionConfig(section: SectionNode, config: SectionConfig): void {
  section.setPluginData('teleport-config', JSON.stringify(config));
}

function getTopLevelSelection(selection: readonly SceneNode[]): SceneNode[] {
  const idSet = new Set(selection.map(n => n.id));
  return selection.filter(node => {
    let parent = node.parent;
    while (parent && parent.type !== 'PAGE' && parent.type !== 'DOCUMENT') {
      if (idSet.has(parent.id)) return false;
      parent = parent.parent;
    }
    return true;
  });
}

// ── Layout algorithms ────────────────────────────────────────────────

function layoutHorizontal(nodes: SceneNode[], hGap: number): void {
  let cursorX = 0;
  for (const node of nodes) {
    node.x = cursorX;
    node.y = 0;
    cursorX += node.width + hGap;
  }
}

function layoutVertical(nodes: SceneNode[], vGap: number): void {
  let cursorY = 0;
  for (const node of nodes) {
    node.x = 0;
    node.y = cursorY;
    cursorY += node.height + vGap;
  }
}

function layoutGrid(
  nodes: SceneNode[],
  cols: number,
  rows: number,
  hGap: number,
  vGap: number
): void {
  if (cols < 1 && rows > 0) {
    cols = Math.ceil(nodes.length / rows);
  }
  if (cols < 1) cols = 1;

  // Compute max width per column
  const colWidths: number[] = new Array(cols).fill(0);
  for (let i = 0; i < nodes.length; i++) {
    const col = i % cols;
    colWidths[col] = Math.max(colWidths[col], nodes[i].width);
  }

  // Compute X offset for each column
  const colX: number[] = [0];
  for (let c = 1; c < cols; c++) {
    colX[c] = colX[c - 1] + colWidths[c - 1] + hGap;
  }

  // Place row-by-row
  let cursorY = 0;
  for (let i = 0; i < nodes.length; i += cols) {
    const rowNodes = nodes.slice(i, i + cols);
    let rowHeight = 0;
    for (let j = 0; j < rowNodes.length; j++) {
      rowNodes[j].x = colX[j];
      rowNodes[j].y = cursorY;
      rowHeight = Math.max(rowHeight, rowNodes[j].height);
    }
    cursorY += rowHeight + vGap;
  }
}

function layoutMasonry(
  nodes: SceneNode[],
  cols: number,
  rows: number,
  hGap: number,
  vGap: number
): void {
  if (cols < 1 && rows > 0) {
    cols = Math.ceil(nodes.length / rows);
  }
  if (cols < 1) cols = 1;

  const maxWidth = Math.max(...nodes.map(n => n.width));
  const colX: number[] = [];
  const colHeight: number[] = [];
  for (let c = 0; c < cols; c++) {
    colX[c] = c * (maxWidth + hGap);
    colHeight[c] = 0;
  }

  for (const node of nodes) {
    // Find shortest column
    let shortest = 0;
    for (let c = 1; c < cols; c++) {
      if (colHeight[c] < colHeight[shortest]) shortest = c;
    }
    node.x = colX[shortest];
    node.y = colHeight[shortest];
    colHeight[shortest] += node.height + vGap;
  }
}

function arrangeNodes(nodes: SceneNode[], config: SectionConfig): void {
  if (nodes.length === 0) return;
  switch (config.layout) {
    case 'horizontal':
      layoutHorizontal(nodes, config.hGap);
      break;
    case 'vertical':
      layoutVertical(nodes, config.vGap);
      break;
    case 'grid':
      if (config.masonry) {
        layoutMasonry(nodes, config.columns, config.rows, config.hGap, config.vGap);
      } else {
        layoutGrid(nodes, config.columns, config.rows, config.hGap, config.vGap);
      }
      break;
  }
}

// ── Section resizing ─────────────────────────────────────────────────

function resizeSectionToFit(section: SectionNode): void {
  if (section.children.length === 0) return;

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const child of section.children) {
    minX = Math.min(minX, child.x);
    minY = Math.min(minY, child.y);
    maxX = Math.max(maxX, child.x + child.width);
    maxY = Math.max(maxY, child.y + child.height);
  }

  // Shift all children so they start at (SECTION_PADDING, SECTION_PADDING)
  const offsetX = SECTION_PADDING - minX;
  const offsetY = SECTION_PADDING - minY;
  for (const child of section.children) {
    child.x += offsetX;
    child.y += offsetY;
  }

  section.resizeWithoutConstraints(
    maxX - minX + SECTION_PADDING * 2,
    maxY - minY + SECTION_PADDING * 2
  );
}

// ── Bounding box of existing section content ─────────────────────────

function getExistingBounds(section: SectionNode, excludeIds: Set<string>): { minX: number; minY: number; maxX: number; maxY: number } | null {
  let hasExisting = false;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const child of section.children) {
    if (excludeIds.has(child.id)) continue;
    hasExisting = true;
    minX = Math.min(minX, child.x);
    minY = Math.min(minY, child.y);
    maxX = Math.max(maxX, child.x + child.width);
    maxY = Math.max(maxY, child.y + child.height);
  }
  return hasExisting ? { minX, minY, maxX, maxY } : null;
}

// ── Plugin init ──────────────────────────────────────────────────────

figma.showUI(__html__, { width: 240, height: 400, themeColors: true });

figma.on('selectionchange', () => {
  figma.ui.postMessage({
    type: 'selection-changed',
    selectionCount: figma.currentPage.selection.length,
  });
});

figma.on('currentpagechange', () => {
  figma.ui.postMessage({
    type: 'init-data',
    pages: getPages(),
    currentPageId: figma.currentPage.id,
    selectionCount: figma.currentPage.selection.length,
  });
});

figma.ui.onmessage = async (msg: { type: string; [key: string]: unknown }) => {
  // ── Init ───────────────────────────────────────────────────────
  if (msg.type === 'init') {
    figma.ui.postMessage({
      type: 'init-data',
      pages: getPages(),
      currentPageId: figma.currentPage.id,
      selectionCount: figma.currentPage.selection.length,
    });
    return;
  }

  // ── Page selected ──────────────────────────────────────────────
  if (msg.type === 'page-selected') {
    const sections = await getTeleportSections(msg.pageId as string);
    figma.ui.postMessage({
      type: 'sections-data',
      sections,
    });
    // Refresh page dropdown with updated dot indicators
    figma.ui.postMessage({
      type: 'pages-updated',
      pages: getPages(),
      currentPageId: figma.currentPage.id,
    });
    return;
  }

  // ── Resize ─────────────────────────────────────────────────────
  if (msg.type === 'resize') {
    figma.ui.resize(240, msg.height as number);
    return;
  }

  // ── Teleport ───────────────────────────────────────────────────
  if (msg.type === 'teleport') {
    const selection = figma.currentPage.selection;
    if (selection.length === 0) {
      figma.notify('Select at least one layer');
      return;
    }

    const targetPage = figma.root.children.find(p => p.id === msg.targetPageId);
    if (!targetPage) {
      figma.notify('Target page not found');
      return;
    }

    await targetPage.loadAsync();

    const config: SectionConfig = {
      layout: msg.layout as SectionConfig['layout'],
      columns: msg.columns as number,
      rows: msg.rows as number,
      masonry: msg.masonry as boolean,
      hGap: msg.hGap as number,
      vGap: msg.vGap as number,
    };

    const mode = msg.mode as 'move' | 'copy';
    const rearrange = msg.rearrange as boolean;

    // Get or create section
    let section: SectionNode;
    if (msg.targetSectionId) {
      const found = targetPage.findOne(n => n.id === msg.targetSectionId) as SectionNode | null;
      if (!found) {
        figma.notify('Target section not found');
        return;
      }
      section = found;
    } else {
      section = await createTeleportSection(targetPage, msg.newSectionName as string, config);
    }

    // Prepare nodes
    const topLevel = getTopLevelSelection(selection);
    const nodesToPlace: SceneNode[] = [];
    for (const node of topLevel) {
      if (mode === 'copy') {
        nodesToPlace.push(node.clone());
      } else {
        nodesToPlace.push(node);
      }
    }

    // Append to section
    const newIds = new Set(nodesToPlace.map(n => n.id));
    for (const node of nodesToPlace) {
      section.appendChild(node);
    }

    if (rearrange) {
      // Re-layout ALL children
      const allChildren = [...section.children] as SceneNode[];
      arrangeNodes(allChildren, config);
    } else {
      // Layout only new nodes, offset past existing content
      const existingBounds = getExistingBounds(section, newIds);
      arrangeNodes(nodesToPlace, config);
      if (existingBounds) {
        if (config.layout === 'vertical') {
          // Align X with existing, stack below
          for (const n of nodesToPlace) {
            n.x += existingBounds.minX;
            n.y += existingBounds.maxY + config.vGap;
          }
        } else if (config.layout === 'horizontal') {
          // Align Y with existing, append to the right
          for (const n of nodesToPlace) {
            n.x += existingBounds.maxX + config.hGap;
            n.y += existingBounds.minY;
          }
        } else {
          // Grid/masonry: rearrange all for correct placement
          const allChildren = [...section.children] as SceneNode[];
          arrangeNodes(allChildren, config);
        }
      }
    }

    // Update config and resize
    updateSectionConfig(section, config);
    resizeSectionToFit(section);

    // Mark target page as having teleport sections
    targetPage.setPluginData('hasTeleportSections', 'true');

    const label = topLevel.length === 1 ? 'layer' : 'layers';
    const verb = mode === 'copy' ? 'copied' : 'teleported';
    const sectionRef = section;
    const pageRef = targetPage;
    figma.notify(`${topLevel.length} ${label} ${verb}`, {
      button: {
        text: 'Go there',
        action: () => {
          figma.setCurrentPageAsync(pageRef).then(() => {
            figma.viewport.scrollAndZoomIntoView([sectionRef]);
          });
          return false;
        },
      },
    });

    figma.ui.postMessage({ type: 'done', count: topLevel.length, sectionId: section.id });
  }
};
