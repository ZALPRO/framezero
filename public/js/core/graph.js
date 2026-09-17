/* ═══════════════════════════════════════════════════════════════
   core/graph.js — the scene graph as a dependency DAG.

   This is the single most important architectural difference from
   After Effects. AE re-renders the whole comp when anything changes.
   Here, touching one property marks exactly the downstream cone dirty
   and nothing else. The counters below are surfaced in the HUD so the
   claim is *measurable*, not marketing.
   ═══════════════════════════════════════════════════════════════ */

let NODE_SEQ = 0;

export class Node {
  constructor(kind, id, compute) {
    this.id = id || `${kind}-${++NODE_SEQ}`;
    this.kind = kind;            // 'asset' | 'layer' | 'effect' | 'text' | 'composite' | 'output'
    this.compute = compute;      // (node, ctx) -> value
    this.inputs = [];            // [Node]
    this.outputs = new Set();    // Set<Node>
    this.value = undefined;
    this.dirty = true;
    this.everEvaluated = false;
    this.evalCount = 0;          // lifetime evaluations (cache-hit proof)
    this.lastEvalMs = 0;
    this.meta = {};              // arbitrary display metadata
    this.depth = 0;
  }
  connectTo(target) {
    if (!this.outputs.has(target)) {
      this.outputs.add(target);
      target.inputs.push(this);
      target.depth = Math.max(target.depth, this.depth + 1);
    }
    return target;
  }
  disconnectFrom(target) {
    this.outputs.delete(target);
    const i = target.inputs.indexOf(this);
    if (i >= 0) target.inputs.splice(i, 1);
  }
}

export class Graph {
  constructor() {
    this.nodes = new Map();
    this.order = [];            // cached topological order
    this.orderDirty = true;
    // ── telemetry: this is what makes the architecture claim auditable ──
    this.stats = {
      totalNodes: 0,
      evaluatedLastPass: 0,
      reusedLastPass: 0,
      totalEvaluations: 0,
      totalReuses: 0,
      passes: 0,
      lastPassMs: 0,
      deepestDirtyChain: 0,
      invalidations: 0,
    };
    this._evaluatedThisPass = 0;
  }

  add(node) { this.nodes.set(node.id, node); this.orderDirty = true; this.stats.totalNodes = this.nodes.size; return node; }

  make(kind, id, compute, meta = {}) {
    const n = new Node(kind, id, compute);
    Object.assign(n.meta, meta);
    return this.add(n);
  }

  remove(id) {
    const n = this.nodes.get(id);
    if (!n) return;
    for (const o of [...n.outputs]) {
      const i = o.inputs.indexOf(n);
      if (i >= 0) o.inputs.splice(i, 1);
      this.markDirty(o);
    }
    for (const i of n.inputs) i.outputs.delete(n);
    this.nodes.delete(id);
    this.orderDirty = true;
    this.stats.totalNodes = this.nodes.size;
  }

  get(id) { return this.nodes.get(id); }

  /** Mark a node and its entire downstream cone dirty. Returns cone size. */
  markDirty(node, _seen) {
    if (!node) return 0;
    const seen = _seen || new Set();
    if (seen.has(node.id)) return 0;
    seen.add(node.id);
    let n = 0;
    if (!node.dirty) { node.dirty = true; this.stats.invalidations++; }
    n++;
    for (const out of node.outputs) n += this.markDirty(out, seen);
    return n;
  }

  /** Convenience: invalidate a node by id. */
  invalidate(id) { const n = this.nodes.get(id); return n ? this.markDirty(n) : 0; }

  topoSort() {
    const visited = new Set();
    const order = [];
    const visit = (n) => {
      if (visited.has(n.id)) return;
      visited.add(n.id);
      for (const i of n.inputs) visit(i);
      order.push(n);
    };
    for (const n of this.nodes.values()) visit(n);
    this.order = order;
    this.orderDirty = false;
    return order;
  }

  /**
   * Evaluate the graph at `ctx.time`.
   * Clean nodes are NOT re-evaluated — their cached .value is reused.
   * That single line is the entire product thesis.
   */
  evaluate(ctx) {
    if (this.orderDirty) this.topoSort();
    const t0 = performance.now();
    let evaluated = 0, reused = 0, deepest = 0;

    for (const node of this.order) {
      if (!node.dirty) { reused++; continue; }
      const s = performance.now();
      try {
        node.value = node.compute ? node.compute(node, ctx) : node.value;
      } catch (err) {
        node.value = undefined;
        node.meta.error = String(err && err.message || err);
        if (ctx && ctx.onError) ctx.onError(node, err);
      }
      node.lastEvalMs = performance.now() - s;
      node.dirty = false;
      node.everEvaluated = true;
      node.evalCount++;
      evaluated++;
      if (node.depth > deepest) deepest = node.depth;
    }

    const ms = performance.now() - t0;
    const st = this.stats;
    st.evaluatedLastPass = evaluated;
    st.reusedLastPass = reused;
    st.totalEvaluations += evaluated;
    st.totalReuses += reused;
    st.passes++;
    st.lastPassMs = ms;
    st.deepestDirtyChain = deepest;
    return { evaluated, reused, ms };
  }

  /** Force the whole graph dirty (used on comp size / fps / quality change). */
  invalidateAll() {
    for (const n of this.nodes.values()) n.dirty = true;
    this.stats.invalidations += this.nodes.size;
  }

  /** Serialise the topology (not values) — used by the Node lens + project format. */
  topology() {
    return [...this.nodes.values()].map(n => ({
      id: n.id, kind: n.kind, inputs: n.inputs.map(i => i.id),
      depth: n.depth, evalCount: n.evalCount, dirty: n.dirty, meta: n.meta,
    }));
  }

  /** Subgraph reachable downstream from a node — what a change actually touches. */
  downstream(id) {
    const root = this.nodes.get(id);
    if (!root) return [];
    const out = [];
    const seen = new Set();
    const walk = (n) => {
      if (seen.has(n.id)) return;
      seen.add(n.id); out.push(n.id);
      for (const o of n.outputs) walk(o);
    };
    walk(root);
    return out;
  }
}

/**
 * Build a per-layer node chain:
 *   source(asset/text) → effect₀ → effect₁ → … → layerTransform → composite
 *
 * Each layer owns a small private chain so that changing one layer's blur
 * radius only re-evaluates that layer's downstream cone — not the comp.
 */
export function buildLayerChain(graph, layer, computeSource, computeEffect, computeTransform) {
  const src = graph.make('source', `${layer.id}:src`, computeSource, { layerId: layer.id, label: layer.name });
  let tail = src;
  const fxNodes = [];
  (layer.effects || []).forEach((fx, i) => {
    const n = graph.make('effect', `${layer.id}:fx${i}:${fx.id}`, computeEffect, { layerId: layer.id, fxIndex: i, label: fx.name });
    tail.connectTo(n);
    tail = n;
    fxNodes.push(n);
  });
  const tr = graph.make('layer', `${layer.id}:tr`, computeTransform, { layerId: layer.id, label: layer.name });
  tail.connectTo(tr);
  return { src, fxNodes, tr, tail: tr };
}
