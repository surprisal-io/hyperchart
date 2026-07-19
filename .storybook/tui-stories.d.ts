declare module "virtual:hyperchart-tui-stories" {
	type TuiTheme = "dark" | "light";
	type TuiWidth = 60 | 80 | 120;
	type TuiComponentKind = "history" | "widget";
	const frames: Record<TuiTheme, Record<TuiWidth, Record<TuiComponentKind, Record<string, string[]>>>>;
	export default frames;
}
