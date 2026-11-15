import { expect, test } from "@playwright/test";
import { newMap } from "../src/lib/imaging";

test("subtract calibrated cycles through the viewer and inspect both signs", async ({page}) => {
  const visits = ["early", "late", "unmatched"].map((id, i) => ({
    id, kind:"cycle", status:"complete", issues:[], observation_ids:[id + "-d1"],
    start_utc:new Date(Date.UTC(2025, i * 6, 1)).toISOString(),
    end_utc:new Date(Date.UTC(2025, i * 6, 2)).toISOString(),
  }));
  const frames = visits.map(v => ({
    id:v.observation_ids[0], observation_id:v.observation_ids[0], visit_id:v.id,
    observed_at:v.start_utc, detector:"D1", channel:"D1 1.000 µm (v1)", processing_version:"v1",
    sequence_id:v.id === "unmatched" ? "other" : "shared", wavelength_um:1, bandwidth_um:0.02,
    url:"/api/assets/test/" + v.id + ".png", pixels:v.id + ".bin",
  }));
  await page.route("**/api/presets", r => r.fulfill({json:{presets:[]}}));
  await page.route("**/api/jobs", r => r.fulfill({json:{job_id:"signed"}}));
  await page.route("**/api/jobs/signed", r => r.fulfill({json:{status:"complete", manifest:{
    visits, frames, processing:{output_shape:[2,2]},
  }}}));
  await page.route("**/api/assets/test/*.bin", r => r.fulfill({body:Buffer.from(
    Float32Array.from(r.request().url().endsWith("/early.bin") ? [8,1,2,4] : [1,8,2,NaN]).buffer)}));
  await page.goto("/explore?ra=5&dec=4&fov=30");
  await expect(page.getByLabel("Displayed image")).toContainText("Visit composite");
  await page.getByRole("checkbox", {name:"Compare with reference", exact:true}).check();
  const image = page.getByLabel("Displayed image");
  await expect(image).toContainText("Cycle difference · reference 2025-01-01");
  await expect(image.locator("time")).toHaveAttribute("datetime", frames[1].observed_at);
  const ref = page.getByLabel("Reference cycle");
  await expect(ref.locator("option[value=unmatched]")).toHaveCount(0);
  const canvas = page.locator("canvas");
  const box = (await canvas.boundingBox())!;
  const spacing = Math.min(box.width, box.height) * 0.94 / 4;
  for (const [side, delta] of [[-1, "-7.0000"], [1, "7.0000"]] as const) {
    await canvas.click({position:{x:box.width / 2 + side * spacing, y:box.height / 2 - spacing}});
    await expect(page.getByText(/Δ at pixel/)).toContainText(delta + " MJy/sr");
  }
  await ref.selectOption("late");
  await page.getByRole("button", {name:"First cycle", exact:true}).click();
  await expect(image).toContainText("Cycle difference · reference 2025-07-01");
  await expect(page.getByText(/Δ at pixel/)).toContainText("-7.0000 MJy/sr");
  await page.getByRole("checkbox", {name:"Compare with reference", exact:true}).uncheck();
  await expect(image).toContainText("Visit composite");
});

test("three nominal matched epochs subtract across cached sequence IDs and retain configured map layers", async ({page}) => {
  await page.setViewportSize({width:1440,height:900});
  const dates=["2025-01-01","2025-07-01","2026-01-01"];
  const visits=dates.map((date,index) => ({id:"epoch-"+index,kind:"supplemental",status:"complete",issues:[],
    observation_ids:["nominal-"+index],start_utc:date+"T00:00:00Z",end_utc:date+"T00:00:00Z"}));
  const frames=visits.map((visit,index) => ({id:"nominal-"+index,observation_id:"nominal-"+index,visit_id:visit.id,
    observed_at:visit.start_utc,detector:"D1",nominal_channel:3,processing_version:"v1",sequence_id:"cached-job-"+index,
    wavelength_um:1+index*0.001,bandwidth_um:0.02,
    match_wavelengths:Array(5).fill(1+index*0.001),match_bandwidths:Array(5).fill(0.02),
    url:"/api/assets/nominal/f"+index+".png",pixels:"f"+index+".bin"}));
  const values=[[8,1,2,NaN],[1,8,2,4],[12,1,3,5]];
  await page.route("**/api/presets",route=>route.fulfill({json:{presets:[]}}));
  await page.route("**/api/jobs",route=>route.fulfill({json:{job_id:"nominal"}}));
  await page.route("**/api/jobs/nominal",route=>route.fulfill({json:{status:"complete",manifest:{frames,visits,
    processing:{output_shape:[2,2]}}}}));
  await page.route("**/api/assets/nominal/*.bin",route=>{
    const index=Number(new URL(route.request().url()).pathname.match(/f(\d)\.bin$/)![1]);
    return route.fulfill({body:Buffer.from(Float32Array.from(values[index]).buffer)});
  });
  const maps=[
    {...newMap("warm","Warm"),operands:{"D1-03":1},stretch:"sqrt",low:"-12",high:"12",
      stops:[{at:0,color:"#00000000"},{at:1,color:"#ff0000"}]},
    {...newMap("cool","Cool"),operands:{"D1-03":1},stretch:"linear",low:"-8",high:"8",
      stops:[{at:0,color:"#00000000"},{at:1,color:"#0000ff"}]},
  ];
  await page.goto("/explore?ra=5&dec=4&fov=30&view="+encodeURIComponent(JSON.stringify({maps})));
  await expect(page.getByLabel("Map name 1",{exact:true})).toHaveValue("Warm");
  await expect(page.getByLabel("Map name 2",{exact:true})).toHaveValue("Cool");
  await expect(page.getByRole("button",{name:"Zoom in",exact:true})).toBeEnabled();
  await expect(page.getByRole("button",{name:"Play",exact:true})).toBeEnabled();
  await page.getByRole("checkbox",{name:"Compare with reference",exact:true}).check();
  await page.getByRole("button",{name:"Last cycle",exact:true}).click();
  const image=page.getByLabel("Displayed image",{exact:true});
  await expect(image).toContainText("Cycle difference · reference 2025-01-01");
  await expect(image.locator("time")).toHaveAttribute("datetime",frames[2].observed_at);
  await page.getByRole("checkbox",{name:"Color scale",exact:true}).check();
  const scale=page.getByRole("group",{name:"Displayed color scale",exact:true});
  await expect(scale).toContainText("Δ Warm · -12.00 … 12.00 MJy/sr · sqrt");
  await expect(scale).toContainText("Δ Cool · -8.000 … 8.000 MJy/sr · linear");
  const canvas=page.locator(".sky-canvas canvas");
  const rect=(await canvas.boundingBox())!;
  const spacing=Math.min(rect.width,rect.height)*0.94/4;
  await canvas.click({position:{x:rect.width/2-spacing,y:rect.height/2-spacing}});
  await expect(page.getByText(/Δ at pixel/)).toContainText("4.0000 MJy/sr");
  await page.getByRole("combobox",{name:"Reference cycle",exact:true}).selectOption("epoch-1");
  await page.getByRole("button",{name:"First cycle",exact:true}).click();
  await expect(page.getByText(/Δ at pixel/)).toContainText("7.0000 MJy/sr");
});
