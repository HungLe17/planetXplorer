import { expect, test } from "@playwright/test";

test("unified desktop timeline groups epochs, inspects repeats, compares a reference and keeps cutout status beside the image", async ({page}) => {
  await page.setViewportSize({width:1440,height:900});
  const dates=["2025-01-01","2025-01-02","2025-07-01"];
  const frames=dates.map((date,index) => ({id:"f"+index,observation_id:"o"+index,detector:"D1",
    nominal_channel:3,processing_version:"v1",sequence_id:"same",wavelength_um:.79,bandwidth_um:.02,
    match_wavelengths:Array(5).fill(.79),match_bandwidths:Array(5).fill(.02),
    observed_at:date+"T00:00:00Z",visit_id:index<2?"early":"late",
    url:"/api/assets/unified/f"+index+".png",pixels:"f"+index+".bin"}));
  const visits=[{id:"early",observation_ids:["o0","o1"],start_utc:frames[0].observed_at,end_utc:frames[1].observed_at},
    {id:"late",observation_ids:["o2"],start_utc:frames[2].observed_at,end_utc:frames[2].observed_at}]
    .map(v=>({...v,kind:"cycle",status:"complete",issues:[]}));
  const observations=frames.map(f=>({...f,id:f.observation_id,source_url:"",release:"DR1",status:"ready",selection:"matched"}));
  let complete=false;
  await page.route("**/api/presets",r=>r.fulfill({json:{presets:[]}}));
  await page.route("**/api/jobs",r=>r.fulfill({json:{job_id:"unified"}}));
  await page.route("**/api/jobs/unified",r=>r.fulfill({json:{status:complete?"complete":"running",stage:"fetch:1/3",
    manifest:{frames,visits,observations,processing:{output_shape:[2,2]}}}}));
  await page.route("**/api/assets/unified/*.bin",r=>r.fulfill({body:Buffer.from(new Float32Array([1,2,3,4]).buffer)}));
  await page.goto("/explore?ra=5&dec=4&fov=30");
  const viewer=page.getByRole("region",{name:"Observation viewer",exact:true});
  await expect(viewer.getByRole("status",{name:"Cutout progress",exact:true})).toContainText("Checked 1 of 3 cutouts");
  await expect(page.locator("#notification-inbox")).not.toContainText("Checked 1 of 3 cutouts");
  for (const mode of ["Visits","Browse","Matched"])
    await expect(page.getByRole("button",{name:mode,exact:true})).toHaveCount(0);
  complete=true;
  await expect(page.getByRole("button",{name:"Search observations",exact:true})).toBeEnabled();
  await expect(page.locator(".frame-counter")).toContainText("/ 02");
  await page.getByLabel("Matched spectra",{exact:true}).click();
  const spectrum=page.locator(".matched-options details details > summary").first();
  if(!await spectrum.evaluate(el=>el.parentElement!.hasAttribute("open"))) await spectrum.click();
  await spectrum.locator("..").getByRole("button").first().click();
  await page.getByRole("button",{name:"Next cycle",exact:true}).click();
  await expect(page.locator(".frame-counter")).toContainText("02 /");
  const compare=page.getByRole("checkbox",{name:"Compare with reference",exact:true});
  await compare.check();
  await expect(page.getByLabel("Displayed image")).toContainText("Cycle difference");
  await compare.uncheck();
  const early=page.getByRole("region",{name:"Cycle 1",exact:true});
  await early.locator(".cycle-disclosure").click();
  const repeat=early.getByRole("row").filter({has:page.getByText("o1",{exact:true})});
  await repeat.getByRole("button",{name:"View",exact:true}).click();
  await expect(page.getByRole("button",{name:"Return to timeline",exact:true})).toBeVisible();
  await expect(page.getByLabel("Frame details",{exact:true})).toContainText("o1");
  await page.getByRole("button",{name:"Return to timeline",exact:true}).click();
  await expect(page.getByRole("button",{name:"Play",exact:true})).toBeEnabled();
  await expect(page.locator(".frame-counter")).toContainText("/ 02");
});
