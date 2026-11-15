import { expect, test } from "@playwright/test";

test("archive comparison is lazy, side by side, retries independently and keeps original FITS links",async({page})=>{
  await page.setViewportSize({width:1440,height:900});
  const requests:string[]=[];
  const png="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
  let fail=true;
  await page.route("**/api/presets",r=>r.fulfill({json:{presets:[]}}));
  await page.route("**/api/jobs",r=>r.fulfill({json:{job_id:"field"}}));
  await page.route("**/api/jobs/field",r=>r.fulfill({json:{status:"complete",manifest:{frames:[]}}}));
  await page.route("**/api/surveys/**",r=>{
    const name=new URL(r.request().url()).pathname.split("/").pop()!;
    requests.push(name);
    if(name==="euclid-images" && fail) return r.fulfill({status:502,json:{detail:"Temporary failure"}});
    return r.fulfill({json:{images:[{band:name==="neowise"?"W1":"NIR-H",source_url:"https://archive.test/"+name+".fits",
      product_url:name==="euclid-images"?"https://archive.test/original.fits":undefined,preview:png}]}});
  });
  await page.goto("/explore?ra=5&dec=2");
  await expect(page.getByText("No comparable observations were found",{exact:false})).toBeAttached();
  expect(requests).toEqual([]);
  await page.getByText("EUCLID / NEOWISE comparison",{exact:true}).click();
  const wise=page.getByRole("region",{name:"NEOWISE images",exact:true});
  const euclid=page.getByRole("region",{name:"EUCLID images",exact:true});
  await expect(wise.getByRole("img")).toBeVisible();
  await expect(euclid.getByRole("button",{name:"Retry EUCLID",exact:true})).toBeVisible();
  fail=false;
  await euclid.getByRole("button",{name:"Retry EUCLID",exact:true}).click();
  await expect(euclid.getByRole("img")).toBeVisible();
  await expect(euclid.getByRole("link",{name:/Original science FITS/})).toHaveAttribute("href","https://archive.test/original.fits");
  expect(requests.filter(s=>s==="neowise")).toHaveLength(1);
  expect(requests).not.toContain("desi");
  const w=(await wise.boundingBox())!,e=(await euclid.boundingBox())!;
  expect(w.x).toBeGreaterThan(e.x);
  await page.getByText("EUCLID / NEOWISE comparison",{exact:true}).click();
  await expect(wise).toHaveCount(0);
});
