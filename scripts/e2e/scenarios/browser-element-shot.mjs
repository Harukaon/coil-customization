// The screenshot attached to a picked element must show that element — including when the
// page is scrolled, which is where it used to come out blank.
export const description = "选中网页元素自动附的截图：滚动过的页面里也是元素本身，不是空白";

const inPage = (app, marker, code) => app.evaluate(({ webContents }, [marker, code]) => {
  const contents = webContents.getAllWebContents().find((item) => !item.isDestroyed() && item.getURL().includes(marker));
  return contents ? contents.executeJavaScript(code) : null;
}, [marker, code]);

export async function run({ app, page, ui, site, check, shot }) {
  await ui.newConversation("projA");
  await ui.send([{ tool: "browser_open", args: { url: site.url("scrolled.html") } }, { echo: true }], "元素");
  await ui.waitFor(async () => Boolean(await inPage(app, "scrolled.html", "document.readyState === 'complete'")), 15_000);
  await page.waitForTimeout(800);
  const scrollY = await inPage(app, "scrolled.html", "scrollY");
  check("页面确实滚下去了", scrollY > 1000, String(scrollY));

  const box = await page.locator(".browser-live-page").boundingBox();
  const layout = JSON.parse(await inPage(app, "scrolled.html", "JSON.stringify({ rect: document.querySelector('#t').getBoundingClientRect(), width: innerWidth, height: innerHeight })"));
  const scale = Math.min(box.width / layout.width, box.height / layout.height);
  const target = { x: box.x + (layout.rect.x + 30) * scale, y: box.y + (layout.rect.y + layout.rect.height / 2) * scale };
  await page.getByRole("button", { name: "选择网页元素", exact: true }).click();
  await page.waitForTimeout(400);
  await page.mouse.move(target.x, target.y);
  await page.waitForTimeout(200);
  await page.mouse.click(target.x, target.y);
  await ui.waitFor(async () => (await page.locator(".composer-images figure img").count()) > 0, 10_000);
  await page.waitForTimeout(500);
  await shot("picked");

  const src = await page.locator(".composer-images figure img").first().getAttribute("src");
  const stats = await page.evaluate(async (src) => {
    const img = new Image();
    img.src = src;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const context = canvas.getContext("2d");
    context.drawImage(img, 0, 0);
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let red = 0;
    let transparent = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 10) transparent += 1;
      else if (data[i] > 180 && data[i + 1] < 90 && data[i + 2] < 130) red += 1;
    }
    return { width: canvas.width, height: canvas.height, redShare: red / (data.length / 4), transparentShare: transparent / (data.length / 4) };
  }, src);
  check("截图不是全透明/空白", stats.transparentShare < 0.5, JSON.stringify(stats));
  check("截图里是那个红底元素（红色占大半）", stats.redShare > 0.5, JSON.stringify(stats));

  // The small picture in the composer must show the whole element, not a centre crop of it.
  const thumb = await page.locator(".composer-images figure img").first().evaluate((el) => {
    const box = el.getBoundingClientRect();
    return { width: box.width, height: box.height, natural: el.naturalWidth / el.naturalHeight, fit: getComputedStyle(el).objectFit };
  });
  const shown = thumb.width / thumb.height;
  check("输入框里的缩略图按原比例完整显示元素（不是裁成方块的一小条）", thumb.fit === "contain" && Math.abs(shown - Math.min(thumb.natural, 150 / thumb.height)) < 0.2, JSON.stringify(thumb));
}
