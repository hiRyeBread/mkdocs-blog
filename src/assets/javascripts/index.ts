/*
 * Copyright (c) 2016-2020 Martin Donath <martin.donath@squidfunk.com>
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to
 * deal in the Software without restriction, including without limitation the
 * rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
 * sell copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NON-INFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
 * FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
 * IN THE SOFTWARE.
 */

// DISCLAIMER: this file is still WIP. There're some refactoring opportunities
// which must be tackled after we gathered some feedback on v5.
// tslint:disable

import "focus-visible"

import * as escapeHTML from "escape-html"
import {
  merge,
  combineLatest,
  animationFrameScheduler,
  fromEvent,
  from,
  defer,
  of,
  NEVER,
  asyncScheduler
} from "rxjs"
import {
  delay,
  switchMap,
  tap,
  filter,
  withLatestFrom,
  observeOn,
  take,
  shareReplay,
  catchError,
  map,
  bufferCount,
  distinctUntilKeyChanged,
  mapTo,
  distinctUntilChanged,
  zipWith,
  combineLatestWith,
  skipUntil,
  share,
  debounce,
  startWith,
  debounceTime
} from "rxjs/operators"

import {
  watchToggle,
  setToggle,
  getElements,
  watchMedia,
  watchDocument,
  watchLocation,
  watchLocationHash,
  watchViewport,
  isLocalLocation,
  setLocationHash,
  watchLocationBase,
  getElement,
  createElement,
  watchScript
} from "browser"
import {
  mountHeader,
  mountMain,
  mountNavigation,
  mountSearch,
  mountTableOfContents,
  mountTabs,
  useComponent,
  setupComponents,
  mountSearchQuery,
  mountSearchReset,
  mountSearchResult
} from "components"
import {
  setupClipboard,
  setupDialog,
  setupKeyboard,
  setupInstantLoading,
  setupSearchWorker,
  setupSearchHighlighter,
  isSearchReadyMessage
} from "integrations"
import {
  patchCodeBlocks,
  patchTables,
  patchDetails,
  patchScrollfix,
  patchSource,
  patchScripts
} from "patches"
import { isConfig, h } from "utilities"
import { renderVersion } from "templates/version"

/* ------------------------------------------------------------------------- */

/* Denote that JavaScript is available */
document.documentElement.classList.remove("no-js")
document.documentElement.classList.add("js")

/* Test for iOS */
if (navigator.userAgent.match(/(iPad|iPhone|iPod)/g))
  document.documentElement.classList.add("ios")

/**
 * Set scroll lock
 *
 * @param el - Scrollable element
 * @param value - Vertical offset
 */
export function setScrollLock(
  el: HTMLElement, value: number
): void {
  el.setAttribute("data-md-state", "lock")
  el.style.top = `-${value}px`
}

/**
 * Reset scroll lock
 *
 * @param el - Scrollable element
 */
export function resetScrollLock(
  el: HTMLElement
): void {
  const value = -1 * parseInt(el.style.top, 10)
  el.removeAttribute("data-md-state")
  el.style.top = ""
  if (value)
    window.scrollTo(0, value)
}

// TEST

/* ----------------------------------------------------------------------------
 * Functions
 * ------------------------------------------------------------------------- */

/**
 * Initialize Material for MkDocs
 *
 * @param config - Configuration
 */
export function initialize(config: unknown) {
  if (!isConfig(config))
    throw new SyntaxError(`Invalid configuration: ${JSON.stringify(config)}`)

  /* Set up subjects */
  const document$ = watchDocument()
  const location$ = watchLocation()

  /* Set up user interface observables */
  const base$     = watchLocationBase(config.base, { location$ })
  const hash$     = watchLocationHash()
  const viewport$ = watchViewport()
  const tablet$   = watchMedia("(min-width: 960px)")
  const screen$   = watchMedia("(min-width: 1220px)")

  /* ----------------------------------------------------------------------- */

  /* Set up component bindings */
  setupComponents([
    "announce",                        /* Announcement bar */
    "container",                       /* Container */
    "header",                          /* Header */
    "header-title",                    /* Header title */
    "header-topic",                    /* Header topic */
    "main",                            /* Main area */
    "navigation",                      /* Navigation */
    "search",                          /* Search */
    "search-query",                    /* Search input */
    "search-reset",                    /* Search reset */
    "search-result",                   /* Search results */
    "search-share",                    /* Search share */
    "search-suggest",                  /* Search suggestions */
    "skip",                            /* Skip link */
    "tabs",                            /* Tabs */
    "toc"                              /* Table of contents */
  ], { document$ })

  const keyboard$ = setupKeyboard()

  // Hack: only make code blocks focusable on non-touch devices
  if (matchMedia("(hover)").matches)
    patchCodeBlocks({ document$, viewport$ })
  patchDetails({ document$, hash$ })
  patchScripts({ document$ })
  patchSource({ document$ })
  patchTables({ document$ })

  /* Force 1px scroll offset to trigger overflow scrolling */
  patchScrollfix({ document$ })

  /* Set up clipboard and dialog */
  const dialog$ = setupDialog()
  const clipboard$ = setupClipboard({ document$, dialog$ })

  /* ----------------------------------------------------------------------- */

  /* Create header observable */
  const header$ = useComponent("header")
    .pipe(
      mountHeader({ document$, viewport$ }),
      shareReplay({ bufferSize: 1, refCount: true })
    )

  const main$ = useComponent("main")
    .pipe(
      mountMain({ header$, viewport$ }),
      shareReplay({ bufferSize: 1, refCount: true })
    )

  /* ----------------------------------------------------------------------- */

  const navigation$ = useComponent("navigation")
    .pipe(
      mountNavigation({ header$, main$, viewport$, screen$ }),
      shareReplay({ bufferSize: 1, refCount: true }) // shareReplay because there might be late subscribers
    )

  const toc$ = useComponent("toc")
    .pipe(
      mountTableOfContents({ header$, main$, viewport$, tablet$ }),
      shareReplay({ bufferSize: 1, refCount: true })
    )

  const tabs$ = !config.features.includes("navigation.tabs.sticky")
    ? useComponent("tabs")
      .pipe(
        mountTabs({ header$, viewport$, screen$ }),
        shareReplay({ bufferSize: 1, refCount: true })
      )
    : NEVER

  /* ----------------------------------------------------------------------- */

  const worker$ = useComponent("search")
    .pipe(
      switchMap(() => defer(() => {
        const index = config.search && config.search.index
          ? config.search.index
          : undefined

        /* Fetch index if it wasn't passed explicitly */
        const index$ = (
          typeof index !== "undefined"
            ? from(index)
            : base$
                .pipe(
                  switchMap(base => fetch(`${base}/search/search_index.json`, {
                    credentials: "same-origin"
                  }).then(res => res.json()))
                )
        )

        // TODO: clean up implementation
        if (config.features.includes("search.highlight"))
          combineLatest([location$, index$])
            .subscribe(([url, index]) => {
              if (!url.searchParams.has("h"))
                return

              /* Set up highlighter and get query from params */
              const highlight = setupSearchHighlighter(index.config)
              const fn = highlight(url.searchParams.get("h")!)

              /* Retrieve element of interest */
              let el = url.hash
                ? getElement(`[id="${url.hash.slice(1)}"]`)
                : getElement("article")
              if (typeof el === "undefined")
                return

              /* Keep highlighting */
              while (el) {
                const it = document.createNodeIterator(el, NodeFilter.SHOW_TEXT)

                /* Collect text nodes */
                const nodes: ChildNode[] = []
                while (true) {
                  const node = it.nextNode() as ChildNode
                  if (node) {
                    if (!["style", "script"].includes(node.parentElement!.tagName))
                      nodes.push(node)
                  } else {
                    break
                  }
                }

                /* Highlight */
                for (const node of nodes) {
                  if (node.textContent!.trim())
                    node.replaceWith(
                      h("span", null, fn(escapeHTML(node.textContent!))) // TODO: remove the unnecessary span
                    )
                }

                if (el.tagName === "article") {
                  break
                } else {
                  const next = el.nextSibling
                  if (next instanceof HTMLElement && next.tagName.match(/^H[1-6]/))
                    break

                  el = next as any // Hack: fix typings later
                }
              }
            })

          return of(setupSearchWorker(config.search.worker, {
            base$, index$
          }))
      }))
    )

  /* ----------------------------------------------------------------------- */

  /* Mount search query */
  const search$ = worker$
    .pipe(
      switchMap(worker => {

        // Experimental support for OpenSearch and deep linking
        const params = new URLSearchParams(document.location.search)
        if (params.get("q")) {
          useComponent("search-suggest")
            .subscribe(suggest => {
              suggest.innerText = params.get("q")!
              useComponent<HTMLInputElement>("search-query")
                .subscribe(input => input.focus())
            })

          worker.rx$
            .pipe(
              filter(isSearchReadyMessage),
              switchMap(() => useComponent<HTMLInputElement>("search-query"))
            )
              .subscribe(input => {
                input.blur()
                input.value = params.get("q")!
                input.focus()
              })
        }

        const query$ = useComponent<HTMLInputElement>("search-query")
          .pipe(
            mountSearchQuery(worker, { transform: config.search.transform }),
            shareReplay({ bufferSize: 1, refCount: true })
          )

        /* Mount search reset */
        const reset$ = useComponent("search-reset")
          .pipe(
            mountSearchReset(),
            shareReplay({ bufferSize: 1, refCount: true })
          )

        /* Mount search result */
        const result$ = useComponent("search-result")
          .pipe(
            mountSearchResult(worker, { query$ }),
            shareReplay({ bufferSize: 1, refCount: true })
          )

        // Experimental search suggestions...
        if (config.features.includes("search.suggest")) {
          result$
            .pipe(
              withLatestFrom(query$)
            )
              .subscribe(([{ suggestions }, query]) => {
                if (typeof suggestions !== "undefined") {
                  const container = document.querySelector(".md-search__suggest")!

                  // split using the tokenizer separator... for now just use the default
                  // wrapped in parenthesis, so we know how much whitespace is stripped.
                  const words = query.value.split(/([\s-]+)/)

                  // now, take the last word and check how much we entered of it
                  if (suggestions.length) {
                    const [last] = suggestions.slice(-1)
                    if (
                      suggestions.length >= query.value.split(/[\s-]+/).length &&
                      last.startsWith(words[words.length - 1])
                    ) {
                      // now just replace the last word with the last suggestion!
                      const span = document.createElement("span")
                      span.innerHTML = [...words.slice(0, -1), last].join("")
                      container.innerHTML = ""
                      container.appendChild(span)
                    } else {
                      container.innerHTML = ""
                    }
                  } else {
                    container.innerHTML = ""
                  }
                }
              })

          useComponent<HTMLInputElement>("search-query")
            .pipe(
              switchMap(el => fromEvent(el, "keydown")
                .pipe(
                  observeOn(asyncScheduler),
                  map(() => el.value),
                  distinctUntilChanged(),
                  map(() => {
                    const span = document.querySelector(".md-search__suggest span")
                    if (span) {
                      if (
                        !span.innerHTML.startsWith(el.value) ||
                        el.value.endsWith(" ") ||
                        el.value.length === 0
                      ) {
                        span.innerHTML = ""
                      }
                    }
                  })
                )
              )
            )
              .subscribe()
        }

        return useComponent("search")
          .pipe(
            mountSearch(worker, { query$, reset$, result$ }),
          )
      }),
      catchError(() => {
        useComponent("search")
          .subscribe(el => el.hidden = true) // TODO: Hack
        return NEVER
      }),
      shareReplay({ bufferSize: 1, refCount: true })
    )

  /* ----------------------------------------------------------------------- */

  // // put into search...
  hash$
    .pipe(
      tap(() => setToggle("search", false)),
      delay(125), // ensure that it runs after the body scroll reset...
    )
      .subscribe(hash => setLocationHash(`#${hash}`))

  // TODO: scroll restoration must be centralized
  combineLatest([
    watchToggle("search"),
    tablet$,
  ])
    .pipe(
      withLatestFrom(viewport$),
      switchMap(([[toggle, tablet], { offset: { y }}]) => {
        const active = toggle && !tablet
        return document$
          .pipe(
            delay(active ? 400 : 100),
            observeOn(animationFrameScheduler),
            tap(({ body }) => active
              ? setScrollLock(body, y)
              : resetScrollLock(body)
            )
          )
      })
    )
      .subscribe()

  /* ----------------------------------------------------------------------- */

  /* Always close drawer on click */
  fromEvent<MouseEvent>(document.body, "click")
    .pipe(
      filter(ev => !(ev.metaKey || ev.ctrlKey)),
      filter(ev => {
        if (ev.target instanceof HTMLElement) {
          const el = ev.target.closest("a") // TODO: abstract as link click?
          if (el && isLocalLocation(el)) {
            return true
          }
        }
        return false
      })
    )
      .subscribe(() => {
        setToggle("drawer", false)
      })

  /* Enable instant loading, if not on file:// protocol */
  if (
    config.features.includes("navigation.instant") &&
    location.protocol !== "file:"
  ) {
    const dom = new DOMParser()

    /* Fetch sitemap and extract URL whitelist */
    base$
      .pipe(
        switchMap(base => from(fetch(`${base}/sitemap.xml`)
          .then(res => res.text())
          .then(text => dom.parseFromString(text, "text/xml"))
        )),
        withLatestFrom(base$),
        map(([document, base]) => {
          const urls = getElements("loc", document)
            .map(node => node.textContent!)

          // Hack: This is a temporary fix to normalize instant loading lookup
          // on localhost and Netlify previews. If this approach proves to be
          // suitable, we'll refactor URL whitelisting anyway. We take the two
          // shortest URLs and determine the common prefix to isolate the
          // domain. If there're no two domains, we just leave it as-is, as
          // there isn't anything to be loaded anway.
          if (urls.length > 1) {
            const [a, b] = urls.sort((a, b) => a.length - b.length)

            /* Determine common prefix */
            let index = 0
            if (a === b)
              index = a.length
            else
              while (a.charAt(index) === b.charAt(index))
                index++

            /* Replace common prefix (i.e. base) with effective base */
            for (let i = 0; i < urls.length; i++)
              urls[i] = urls[i].replace(a.slice(0, index), `${base}/`)
          }
          return urls
        })
      )
        .subscribe(urls => {
          setupInstantLoading(urls, { document$, location$, viewport$ })
        })
  }

  /* ----------------------------------------------------------------------- */

  // Make indeterminate toggles indeterminate to expand navigation on screen
  document$.subscribe(() => {
    const toggles = getElements<HTMLInputElement>("[data-md-state=indeterminate]")
    for (const toggle of toggles) {
      toggle.dataset.mdState = ""
      toggle.indeterminate = true
      toggle.checked = false
    }
  })

  // Auto hide header - this is still experimental, so there might be some
  // opportunities for refactoring, but we'll address them when this feature
  // got some feedback from the community.
  if (config.features.includes("header.autohide")) {
    viewport$
      .pipe(
        map(({ offset }) => offset.y),
        bufferCount(2, 1),
        map(([a, b]) => [a < b, b] as const),
        distinctUntilKeyChanged(0),
        switchMap(([direction, y0]) => viewport$
          .pipe(
            map(({ offset }) => offset.y),
            filter(y1 => y1 > 400),
            map(y1 => Math.abs(y0 - y1)),
            filter(y => y > 100),
            map(() => direction),
            take(1)
          )
        )
      )
        .subscribe(hide => {
          const header = getElement("[data-md-component=header]")
          header?.setAttribute("data-md-state", hide ? "hidden": "shadow")
        })
  }

  // Make indeterminate toggles indeterminate to expand navigation on screen
  document$.subscribe(() => {
    const toggles = getElements<HTMLInputElement>("[data-md-state=indeterminate]")
    for (const toggle of toggles) {
      toggle.dataset.mdState = ""
      toggle.indeterminate = true
      toggle.checked = false
    }
  })

  // getOption? what about local storage?
  const palettes = getElements("[data-md-option=palette]")
  for (let i = 0; i < palettes.length; i++) {
    const palette = palettes[i]
    fromEvent(palette, "click")
      .subscribe(() => {
        for (const key of [
          "mdColorScheme",
          "mdColorPrimary",
          "mdColorAccent"
        ]) {
          if (palette.dataset[key])
            document.body.dataset[key] = palette.dataset[key]
        }

        // Hide this button and show the next one
        palettes[i].dataset.mdState = "hidden"

        const next = palettes[(i + 1) % palettes.length]
        next.dataset.mdState = ""
        next.focus()

        // Persist in local storage
        localStorage.setItem(
          "__palette",
          JSON.stringify({
            index: i,
            color: {
              scheme:  palette.dataset.mdColorScheme,
              primary: palette.dataset.mdColorPrimary,
              accent:  palette.dataset.mdColorAccent
            }
          })
        )
      })
  }

  // Just use the first button for now
  if (palettes.length) {
    const { index } = JSON.parse(
      localStorage.getItem("__palette") || "{ \"index\": 0 }"
    )
    palettes[(+index + 1) % palettes.length].dataset.mdState = ""
  }

  // Auto hide header - there are still some problems with this, mainly when
  // the search is open (always show header) and when moving fast to the top.
  if (config.features.includes("header.autohide")) {
    viewport$
      .pipe(
        map(({ offset }) => offset.y),
        bufferCount(2, 1),
        map(([a, b]) => [a < b, b] as const),
        distinctUntilKeyChanged(0),
        switchMap(([direction, y0]) => viewport$
          .pipe(
            map(({ offset }) => offset.y),
            filter(y1 => y1 > 400),
            map(y1 => Math.abs(y0 - y1)),
            filter(y => y > 100),
            mapTo(direction),
            take(1)
          )
        )
      )
        // this must be done directly in the header component
        .subscribe(hide => {
          const header = getElement("[data-md-component=header]")
          header?.setAttribute("data-md-state", hide ? "hidden": "shadow")
        })
  }

  // Render version selector and use mike as an engine
  if (
    typeof config.version !== "undefined" &&
    config.version.method === "mike"
  ) {
    const version$ = base$
      .pipe(
        switchMap(base => fetch(`${base}/../versions.json`, {
          credentials: "same-origin"
        }).then(res => res.json())),
        catchError(() => {
          console.log("Couldn't load versions.json")
          return NEVER
        })
      )

    useComponent("header-title")
      .pipe(
        map(el => el.querySelector(".md-header__topic")!),
        zipWith(base$, version$)
      )
        .subscribe(([el, base, version]) => {
          el.appendChild(renderVersion(base, version))
        })
  }

  // Experimental support for sharing (deep-linking) search (results)
  search$
    .pipe(
      map(({ query }) => query.value),
      combineLatestWith(useComponent<HTMLLinkElement>("search-share"))
    )
      .subscribe(([text, el]) => {
        el.href = "?q=" + text.replace(/\s+/g, "+")
      })

  useComponent<HTMLLinkElement>("search-share")
    .pipe(
      switchMap(el => fromEvent(el, "click")
        .pipe(
          tap(ev => {
            ev.preventDefault()
            el.setAttribute("data-clipboard-text", new URL(el.href).toString())
          })
        )
      )
    )
      .subscribe(() => {})

  // Experimental mermaid integration - extract all Mermaid diagrams
  const diagrams$ = document$
    .pipe(
      map(() => getElements('.mermaid-experimental')),
      filter(blocks => blocks.length > 0)
    )

  // Load Mermaid
  const loaded$ = diagrams$
    .pipe(
      take(1),
      switchMap(() => (
        watchScript("https://unpkg.com/mermaid@8.8.4/dist/mermaid.min.js")
      )),
      tap(() => {
        const startOnLoad = false
        mermaid.initialize({
          startOnLoad,
          themeCSS
        })
      })
    )

  loaded$
    .pipe(
      switchMap(() => diagrams$),
      debounceTime(10) // TODO: hack, sometimes doubled-triggered on second load
    )
    .subscribe(blocks => {
      blocks.forEach((block, index) => {
        // console.log(block, index)
        const code = block.innerText
        mermaid.mermaidAPI.render(`__mermaid_${index}`, code, (svg: string) => {
          block.innerHTML = svg
        })
      })
    })

  /* ----------------------------------------------------------------------- */

  const state = {

    /* Browser observables */
    document$,
    location$,
    viewport$,

    /* Component observables */
    header$,
    main$,
    navigation$,
    search$,
    tabs$,
    toc$,

    /* Integration observables */
    clipboard$,
    keyboard$,
    dialog$
  }

  /* Subscribe to all observables */
  merge(...Object.values(state))
    .subscribe()
  return state
}

declare const mermaid: any // TODO: fix types

const themeCSS = `
  rect.actor {
    fill: white;
  }
  .classLabel .box {
    background-color: var(--md-mermaid-label-bg-color);
    fill: var(--md-mermaid-label-bg-color);
    opacity: 1;
  }
  .classLabel .label {
    font-family: var(--md-mermaid-font-family);
    fill: var(--md-mermaid-label-fg-color)
  }
  .statediagram-cluster.statediagram-cluster .inner {
    fill: var(--md-default-bg-color);
  }
  .statediagram-state rect.divider {
    stroke: var(--md-default-fg-color--lighter);
    fill: var(--md-default-fg-color--lightest);
  }
  .cluster rect {
    stroke: var(--md-default-fg-color--lighter);
    fill: var(--md-default-fg-color--lightest);
  }
  .edgeLabel,
  .edgeLabel rect {
    background-color: var(--md-mermaid-label-bg-color);
    fill: var(--md-mermaid-label-bg-color);
  }
  .cardinality text {
    fill: inherit !important;
  }
  .cardinality,
  g.classGroup text {
    font-family: var(--md-mermaid-font-family);
    fill: var(--md-mermaid-label-fg-color);
  }
  .edgeLabel .label rect {
    fill: transparent;
  }
  .nodeLabel,
  .label,
  .label div .edgeLabel {
    font-family: var(--md-mermaid-font-family);
    color: var(--md-mermaid-label-fg-color);
  }
  .label foreignObject {
    overflow: visible;
  }
  .arrowheadPath,
  marker {
    fill: var(--md-mermaid-edge-color) !important;
  }
  .edgePath .path,
  .flowchart-link,
  .relation,
  .transition {
    stroke: var(--md-mermaid-edge-color);
  }
  .statediagram-cluster rect,
  g.classGroup line,
  g.classGroup rect,
  .node circle,
  .node ellipse,
  .node path,
  .node polygon,
  .node rect {
    fill: var(--md-mermaid-node-bg-color);
    stroke: var(--md-mermaid-node-fg-color);
  }
  .node circle.state-end {
    fill: var(--md-mermaid-label-bg-color);
    stroke: none;
  }
  .node circle.state-start {
    fill: var(--md-mermaid-label-fg-color);
    stroke: var(--md-mermaid-label-fg-color);
  }
`
