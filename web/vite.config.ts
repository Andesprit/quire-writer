import { defineConfig } from "vite"

export default defineConfig({
  build: {
    rolldownOptions: { input: { main: "index.html", markdown: "markdown.html", pdf: "pdf.html" } },
  },
})
