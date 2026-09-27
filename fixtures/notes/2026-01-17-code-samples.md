---
created: 2026-01-17
updated: 2026-01-17
tags: [code]
---

# コードブロックの見本

コードブロックの中の `{{` と `[[` と `#` は解析しない。

```yaml
on: push
jobs:
  build:
    steps:
      - run: echo "${{ github.sha }}"
```

```cpp
#include <vector>
// [[not-a-link]]
```

インラインコードの `[[not-a-link-inline]]` と `{{not-a-macro}}` と `#not-a-tag` も解析しない。

~~~
[[tilde-fence-not-a-link]]
~~~

本文のリンク [[2026-01-16-mermaid-sample]] は解析する。
