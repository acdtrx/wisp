# Backlog

Pending small items, one entry each. Items that outgrow their entry graduate
to a plan in `docs/plans/` (see `CLAUDE.md` § Plans).

- **Sidebar: manual within-section workload ordering** — a third sort mode
  alongside alphabetical and online-first; the order lives on the section
  assignments so it is the single ordering shared by every consumer. Revisit
  when: the existing sorts demonstrably fight a real workflow — repeatedly
  hunting for a workload the sort keeps burying.
- **Live VM memory growth (balloon headroom / virtio-mem)** — wisp pins
  `<memory>` equal to `<currentMemory>`, so a running VM's RAM ceiling is its
  boot-time size and every increase costs a stop/start. Writing `<maxMemory>`
  above `<currentMemory>` and driving the virtio balloon (or virtio-mem) live
  would allow growth without restart. Semantics to design: how much headroom
  to define, guest cooperation, and what the Overview shows. Trigger observed
  2026-08-26: the play VM (4 GiB) OOM-killed a working agent session and the
  RAM bump required restarting everything inside. Revisit when: it happens
  again, or a memory bump needs to land on a VM that can't be restarted.
