#set page(paper: "a4", margin: 2.5cm)
#set text(size: 11pt)
#set par(justify: true)
#set heading(numbering: "1.")
#set math.equation(numbering: "(1)")

#align(center, text(17pt, weight: "bold")[Untitled])

= Introduction <intro>

This is a Typst document. Write *bold*, _italic_, `code` and
#link("https://typst.app/docs")[links].

- A bullet list
- with two items

+ A numbered list
+ with two items

== Math

Inline math sits in dollar signs, like $a^2 + b^2 = c^2$. Spaces inside the dollar
signs make a numbered equation:

$ sum_(k=1)^n k = (n(n + 1)) / 2 $ <sum>

== Tables

#figure(
  table(
    columns: 2,
    [Item], [Value],
    [Alpha], [1],
    [Beta], [2],
  ),
  caption: [A small table.],
) <items>

@items and @sum are numbered for you. @intro is the start.
