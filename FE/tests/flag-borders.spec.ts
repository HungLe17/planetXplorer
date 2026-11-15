import { expect, test } from "@playwright/test";
import { newMap } from "../src/lib/imaging";

test("flag borders show checker severity, preserve pixel interiors and follow PNG and GIF exports", async ({page}) => {
  await page.setViewportSize({width:1440,height:900});
  const map = {...newMap("flags","Flags"), operands:{D1:1}, stretch:"linear", low:"0", high:"10",
    stops:[{at:0,color:"#000000"},{at:1,color:"#00ff00"}]};
  const frame = {id:"image",observation_id:"image",url:"/api/assets/flags/image.png",
    observed_at:"2026-01-01T00:00:00Z",detector:"D1",nominal_channel:1,quality:"quality.bin"};
  const frames = [frame,{...frame,id:"later",observation_id:"later",observed_at:"2026-07-01T00:00:00Z"}];
  const quality = Buffer.alloc(27);
  [2 ** 21,4,128|4].forEach((flags,i) => {
    quality.writeFloatLE(10,i*4);
    quality.writeUInt32LE(flags,12+i*4);
    quality[24+i]=1;
  });
  await page.route("**/api/presets",r => r.fulfill({json:{presets:[]}}));
  await page.route("**/api/jobs",r => r.fulfill({json:{job_id:"flags"}}));
  await page.route("**/api/jobs/flags",r => r.fulfill({json:{status:"complete",
    manifest:{frames,processing:{output_shape:[1,3]}}}}));
  await page.route("**/api/assets/flags/quality.bin",r => r.fulfill({body:quality}));
  await page.goto("/explore?ra=5&dec=2&view="+encodeURIComponent(JSON.stringify({maps:[map]})));
  await page.getByRole("button",{name:"Matched",exact:true}).click();
  const colors = (canvas:HTMLCanvasElement) => {
    const data = canvas.getContext("2d")!.getImageData(0,0,canvas.width,canvas.height).data;
    let yellow=0,orange=0,green=0;
    for (let i=0;i<data.length;i+=4) {
      if (!data[i+3]) continue;
      const r=data[i],g=data[i+1],b=data[i+2];
      if(r>70 && r<170 && g>210 && b<40)yellow++;
      if(r>70 && r<170 && g>150 && g<210 && b<40)orange++;
      if(r<40 && g>200 && b<40)green++;
    }
    return {yellow:yellow>0,orange:orange>0,green:green>0};
  };
  const canvas = page.locator("canvas").first();
  const borders = page.getByRole("checkbox",{name:/Mark flagged pixels \(2\)/});
  await expect(borders).toBeChecked();
  await expect.poll(() => canvas.evaluate(colors)).toEqual({yellow:true,orange:true,green:true});
  for (const format of ["PNG","GIF"]) {
    const [download] = await Promise.all([page.waitForEvent("download"),
      page.getByRole("button",{name:format,exact:true}).click()]);
    const stream = await download.createReadStream(), chunks:Buffer[]=[];
    for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
    const encoded = Buffer.concat(chunks).toString("base64");
    await page.evaluate(async ({encoded,format}) => {
      const img = new Image();
      img.src="data:image/"+format.toLowerCase()+";base64,"+encoded;
      await img.decode();
      const target = document.createElement("canvas");
      target.id="export-check";target.width=img.width;target.height=img.height;
      target.getContext("2d")!.drawImage(img,0,0);
      document.body.append(target);
    },{encoded,format});
    expect(await page.locator("#export-check").evaluate(colors)).toEqual({yellow:true,orange:true,green:true});
    await page.locator("#export-check").evaluate(el => el.remove());
  }
  await borders.uncheck();
  await expect.poll(() => canvas.evaluate(colors)).toEqual({yellow:false,orange:false,green:true});
});
