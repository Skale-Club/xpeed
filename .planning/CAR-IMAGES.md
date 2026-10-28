# Car pictures in the app — to research and decide later

Status: **idea, not started** (raised 2026-10-28).

## The idea
Show a picture of the owner's car (make/model, ideally year) wherever the car appears
(home, car picker, Cars page), so people recognise "that's my car" at a glance. It can be
generic ("descaracterizado"): a neutral grey car of the right shape is fine. Needs to cover
many cars, the same way the app already has a database of car names.

## Options to look into
1. **Generic silhouettes by body type** (sedan, hatchback, SUV, pickup, minivan, wagon,
   coupe), drawn once as SVG, tinted with a colour the owner picks. Free, consistent,
   works offline, no licensing questions. Body type can come from the VIN decoder
   (NHTSA vPIC returns `BodyClass`) or one question when adding the car.
2. **Rendered-car image services** (pictures by make/model/year/colour, same angle and
   style for every car) — paid, to compare on coverage (Brazilian market too), price,
   terms of use in an app: e.g. Imagin.studio, Evox, CarsXE, DataOne.
3. **Photos from open sources** (e.g. Wikimedia Commons) — free but inconsistent angles,
   backgrounds and licences; probably only as a fallback.
4. **Owner's own photo** of the car — always accurate; optional on top of 1 or 2.

## Questions to answer
- How many of our cars would each option cover (makes/models in Brazil and the US)?
- Cost per image / per month, caching allowed, attribution required?
- One picture per model, or per generation/year?
