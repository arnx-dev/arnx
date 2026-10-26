// Files imported as text (`with { type: "text" }`): the build inlines them, so the binary and the Node bundle carry
// them.
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
declare module "*.toml" {
  const text: string;
  export default text;
}
