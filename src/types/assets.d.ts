declare module "*.txt" {
  const content: string;
  export default content;
}

declare module "*.html" {
  const content: Response;
  export default content;
}
