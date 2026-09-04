export class UnionFind {
  constructor() {
    this.parent = new Map();
  }
  find(x) {
    if (!this.parent.has(x)) this.parent.set(x, x);
    let root = x;
    while (this.parent.get(root) !== root) root = this.parent.get(root);
    // path compression
    let cur = x;
    while (this.parent.get(cur) !== root) {
      const next = this.parent.get(cur);
      this.parent.set(cur, root);
      cur = next;
    }
    return root;
  }
  union(a, b) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
  groups() {
    const out = new Map();
    for (const key of this.parent.keys()) {
      const root = this.find(key);
      if (!out.has(root)) out.set(root, new Set());
      out.get(root).add(key);
    }
    return [...out.values()].map((s) => [...s]);
  }
}
