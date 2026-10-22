// Markdown imported as text (`with { type: "text" }`): the build inlines it, so the binary and the Node bundle carry it.
declare module "*.md" {
  const text: string;
  export default text;
}
declare module "*.ans" {
  const text: string;
  export default text;
}
declare module "*.txt" {
  const text: string;
  export default text;
}
