# ccday

Consommation Claude Code **du jour, par modèle**. Version minimaliste inspirée de [ccusage](https://github.com/ccusage/ccusage).

```
node ccday.mjs [--date YYYY-MM-DD] [--json] [--no-cost]
```

Lit `~/.claude/projects/**/*.jsonl`, affiche Input / Output / Cache Create / Cache Read / Total / Cost par modèle. Aucune dépendance (Node 18+).
