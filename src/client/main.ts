import { today } from "./date";

const app = document.querySelector<HTMLDivElement>("#app")!;
app.innerHTML = `<h1>web-b2</h1><p>${today()}</p>`;
