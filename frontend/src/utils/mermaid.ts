type MermaidApi = typeof import("mermaid").default;

let isMermaidConfigured = false;
let mermaidLoader: Promise<MermaidApi> | null = null;

export async function loadMermaid() {
  if (!mermaidLoader) {
    mermaidLoader = import("mermaid").then(({ default: mermaidApi }) => {
      configureMermaid(mermaidApi);
      return mermaidApi;
    });
  }
  return mermaidLoader;
}

export function hashString(value: string) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(index);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

function configureMermaid(mermaidApi: MermaidApi) {
  if (isMermaidConfigured) return;
  mermaidApi.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: "dark",
    maxTextSize: 100000,
    themeVariables: {
      background: "#071016",
      primaryColor: "#dffefa",
      primaryTextColor: "#082025",
      primaryBorderColor: "#00ffcc",
      lineColor: "#35d8ff",
      secondaryColor: "#d8f7ff",
      secondaryTextColor: "#082025",
      tertiaryColor: "#ecfffb",
      tertiaryTextColor: "#082025",
      edgeLabelBackground: "#0b1118",
      clusterBkg: "#0f172a",
      clusterBorder: "#00ffcc",
      fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, Inter, sans-serif",
      noteBkgColor: "#0f172a",
      noteTextColor: "#dffefa",
      noteBorderColor: "#35d8ff"
    },
    flowchart: {
      curve: "basis",
      htmlLabels: false,
      padding: 20,
      nodeSpacing: 44,
      rankSpacing: 64,
      useMaxWidth: true
    }
  });
  isMermaidConfigured = true;
}
