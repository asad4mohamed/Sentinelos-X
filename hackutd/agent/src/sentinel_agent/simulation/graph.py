"""Directed dependency graph.

Edge semantics (single definition used everywhere):
    Dependency(from_asset_id=A, to_asset_id=B, kind=K)  ==  "A depends on B", with kind K.

    kind = critical : A cannot fully work without B.
    kind = optional : A keeps core function without B but loses some capability.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from ..models import Asset, Dependency, DependencyKind


class GraphError(ValueError):
    pass


@dataclass
class InfraGraph:
    assets: dict[str, Asset]
    edges: list[Dependency]
    # dependencies_of[a] = edges where a is the dependent (a -> b)
    _deps_of: dict[str, list[Dependency]] = field(default_factory=dict, repr=False)
    # dependents_of[b] = edges where b is the dependency (a -> b)
    _dependents_of: dict[str, list[Dependency]] = field(default_factory=dict, repr=False)

    @classmethod
    def build(cls, assets: list[Asset], edges: list[Dependency]) -> "InfraGraph":
        by_id: dict[str, Asset] = {}
        for asset in assets:
            if asset.asset_id in by_id:
                raise GraphError(f"duplicate asset id {asset.asset_id}")
            by_id[asset.asset_id] = asset
        graph = cls(assets=by_id, edges=list(edges))
        seen_edges: set[tuple[str, str]] = set()
        for a in by_id:
            graph._deps_of[a] = []
            graph._dependents_of[a] = []
        for edge in graph.edges:
            for endpoint in (edge.from_asset_id, edge.to_asset_id):
                if endpoint not in by_id:
                    raise GraphError(f"edge {edge.dependency_id} references unknown asset {endpoint}")
            key = (edge.from_asset_id, edge.to_asset_id)
            if key in seen_edges:
                raise GraphError(f"duplicate edge {key[0]} -> {key[1]}")
            seen_edges.add(key)
            graph._deps_of[edge.from_asset_id].append(edge)
            graph._dependents_of[edge.to_asset_id].append(edge)
        return graph

    def has_asset(self, asset_id: str) -> bool:
        return asset_id in self.assets

    def dependencies_of(self, asset_id: str) -> list[Dependency]:
        return list(self._deps_of.get(asset_id, []))

    def dependents_of(self, asset_id: str) -> list[Dependency]:
        return list(self._dependents_of.get(asset_id, []))

    def edges_touching(self, asset_id: str) -> list[Dependency]:
        return self.dependencies_of(asset_id) + self.dependents_of(asset_id)

    def transitive_dependents(self, asset_id: str) -> set[str]:
        """Every asset that directly or indirectly depends on `asset_id` (cycle-safe)."""
        return self._reach(asset_id, self._dependents_of, lambda e: e.from_asset_id)

    def transitive_dependencies(self, asset_id: str) -> set[str]:
        return self._reach(asset_id, self._deps_of, lambda e: e.to_asset_id)

    @staticmethod
    def _reach(start, adjacency, next_of) -> set[str]:
        seen: set[str] = set()
        stack = [start]
        while stack:
            node = stack.pop()
            for edge in adjacency.get(node, []):
                nxt = next_of(edge)
                if nxt not in seen and nxt != start:
                    seen.add(nxt)
                    stack.append(nxt)
        return seen

    def strongly_connected_components(self) -> list[list[str]]:
        """Iterative Tarjan. Returns every SCC (including singletons)."""
        index: dict[str, int] = {}
        low: dict[str, int] = {}
        on_stack: set[str] = set()
        stack: list[str] = []
        result: list[list[str]] = []
        counter = 0
        for root in sorted(self.assets):
            if root in index:
                continue
            work = [(root, iter(self._deps_of[root]))]
            index[root] = low[root] = counter
            counter += 1
            stack.append(root)
            on_stack.add(root)
            while work:
                node, it = work[-1]
                advanced = False
                for edge in it:
                    nxt = edge.to_asset_id
                    if nxt not in index:
                        index[nxt] = low[nxt] = counter
                        counter += 1
                        stack.append(nxt)
                        on_stack.add(nxt)
                        work.append((nxt, iter(self._deps_of[nxt])))
                        advanced = True
                        break
                    if nxt in on_stack:
                        low[node] = min(low[node], index[nxt])
                if advanced:
                    continue
                work.pop()
                if work:
                    parent = work[-1][0]
                    low[parent] = min(low[parent], low[node])
                if low[node] == index[node]:
                    component: list[str] = []
                    while True:
                        member = stack.pop()
                        on_stack.discard(member)
                        component.append(member)
                        if member == node:
                            break
                    result.append(sorted(component))
        return result

    def detect_cycles(self) -> list[list[str]]:
        """Dependency cycles: SCCs with more than one member, or a self-dependency."""
        cycles = [c for c in self.strongly_connected_components() if len(c) > 1]
        for a in self.assets:
            if any(e.to_asset_id == a for e in self._deps_of[a]):
                cycles.append([a])
        return sorted(cycles)

    def cyclic_component_of(self, asset_id: str) -> set[str]:
        for cycle in self.detect_cycles():
            if asset_id in cycle:
                return set(cycle)
        return {asset_id}

    def edge_label(self, edge: Dependency) -> str:
        return f"{edge.from_asset_id}->{edge.to_asset_id}"

    @staticmethod
    def kind_value(edge: Dependency) -> str:
        return edge.kind.value if isinstance(edge.kind, DependencyKind) else str(edge.kind)
