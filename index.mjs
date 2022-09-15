import fetch from "node-fetch";
import puppeteer from "puppeteer";
import fs, { stat } from "fs"
import consola from "consola"

consola.info("NurNet Dumper 1.0.0 started")

function getStatusName (status) {
    if (status === "") return "";
    if (status === "manutenuto" || status === "mantenuto") return "Mantenuto";

    status[0] = status[0].toUpperCase();
      
    return status;
  };

consola.info("Fetching data from NurNet GeoServer")
const data = await fetch("https://nurnet.crs4.it/geoserver/nurnet/ows?service=WFS&version=1.1.0&request=GetFeature&typeName=nurnet:nur_location_anchor&srsName=EPSG:4326&outputFormat=json")
    .then((response) => response.json())
    .catch((error) => {
        consola.error("Failed to get data from NurNet GeoServer. Exiting.");
        consola.error(error);
        process.exit();
    });

consola.success("Obtained " + data.features.length + " POIs from NurNet GeoServer")
consola.info("Mapping data into the new structure")
data.features = data.features.map((feature) => {
    return {
        type: feature.type,
        id: feature.id,
        geometry: feature.geometry,
        properties: {
            content_id: feature.properties.content_id,
            category_id: feature.properties.category,
            date: feature.properties.date.replace("Z", ""),
            comune: feature.properties._Comune,
            source: feature.properties._Fonte,
            stato: getStatusName(feature.properties._Stato),
            name: feature.properties._Nome,
            localita: feature.properties._Localita,
            editor: feature.properties._Editor,
            regione: feature.properties._Regione,
            youtube: feature.properties._Youtube,
            verified: feature.properties.validato
        }
    }
})
consola.success("Finished mapping data")

const browser = await puppeteer.launch()

consola.info("Starting gathering photos from NurNet Blog")

for (let i = 0; i < data.features.length; i++) {
    const page = await browser.newPage();
    await page.goto('https://nurnet.crs4.it/nurnetgeo/pages/it/homepage/view?contentId=' + data.features[i].properties.content_id);
    
    const results = await page.evaluate(() => {
        if (document.querySelector(".slides")) {
            
            const slidesChildren = document.querySelector(".slides").children;
            
            const imageUrls = [];
            
            for (let i = 0; i < slidesChildren.length; i++) {
                imageUrls.push(slidesChildren[i].children[0].src);
            }
            
            return imageUrls;
        }
    })

    await page.close()

    if (results) consola.success((i + 1) + "/" + data.features.length + " POI Content ID " + data.features[i].properties.content_id + " - Acquired " + results.length + (results.length > 1 ? " photos": " photo"))
    else consola.info((i + 1) + "/" + data.features.length + " POI Content ID " + data.features[i].properties.content_id + " - No photos found")
    
    data.features[i].properties.photos = results || []
}
await browser.close()

consola.success("Finished gathering POIs photos")

consola.info("Writing data to disk")
await fs.writeFile("nurnet-data.json", JSON.stringify(data), (error) => {
    if (error) {
        consola.error("Failed to write data to disk. Exiting.")
        consola.error(error)
        process.exit()
    }
})
consola.success("Finished writing data to disk. Exiting.")