#set page(paper: "a4", margin: 2.5cm)
#set text(font: "New Computer Modern", size: 11pt)
#set par(justify: true)

= The Quiet Science of Bread

Bread is one of the oldest foods humans have made. Every loaf starts with the same four ingredients: flour, water, salt, and yeast. What happen between the mixing bowl and the oven is a small miracle of chemistry.

== Fermentation

When yeast eat the sugars in flour, it release carbon dioxide and alcohol. The gas get trapped in a web of gluten, and the dough rise. A baker who wait longer are rewarded with more flavour, because slow fermentation give the bacteria time to produce acids.

The rate of fermentation roughly doubles for every ten degrees of warmth, which we can write as $r(T) = r_0 dot 2^((T - T_0) / 10)$.

== Baking

In the oven, the water inside the loaf turn to steam and the crust brown through the Maillard reaction. *Timing matter more than temperature*, and _patience_ is the most important ingredient of all.

#figure(
  table(
    columns: 2,
    [Stage], [Time],
    [Mixing], [10 min],
    [Rising], [2 hours],
    [Baking], [40 min],
  ),
  caption: [A simple timeline for a country loaf.],
) <timeline>

As @timeline show, most of the work is waiting.
