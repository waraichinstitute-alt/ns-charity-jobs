/* NS Charity Jobs frontend — vanilla JS, no dependencies. */
(function () {
  "use strict";

  var SOURCE_NAMES = {
    charityvillage: "CharityVillage",
    winp: "WorkInNonProfits",
    jobbank: "Job Bank",
  };

  var state = { jobs: [], updatedAt: null };

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function cityOf(loc) {
    return (loc || "").split(",")[0].trim();
  }

  function postedLabel(j) {
    if (j.posted) {
      var days = Math.round((Date.now() - new Date(j.posted + "T00:00:00Z").getTime()) / 86400000);
      if (days <= 0) return "Posted today";
      if (days === 1) return "Posted yesterday";
      return "Posted " + days + " days ago";
    }
    if (j.expires) return "Closing " + j.expires;
    return "Recently posted";
  }

  function primaryLink(j) {
    return (j.links && j.links[0] && j.links[0].url) || "#";
  }

  function renderCard(j) {
    var card = el("article", "card");

    var h2 = el("h2");
    var a = el("a", null, j.title);
    a.href = primaryLink(j);
    a.target = "_blank";
    a.rel = "noopener";
    h2.appendChild(a);
    card.appendChild(h2);

    var emp = el("p", "employer", j.employer);
    if (j.charity) emp.appendChild(el("span", "badge", "✓ Registered charity"));
    card.appendChild(emp);

    var bits = [];
    if (j.location) bits.push(j.location);
    if (j.workModel) bits.push(j.workModel);
    if (j.jobType) bits.push(j.jobType);
    if (j.salary) bits.push(j.salary);
    if (bits.length) {
      var d = el("p", "details");
      bits.forEach(function (b, i) {
        if (i) d.appendChild(el("span", "dot", "·"));
        d.appendChild(document.createTextNode(b));
      });
      card.appendChild(d);
    }

    card.appendChild(el("p", "posted", postedLabel(j)));

    var srcs = el("div", "sources");
    (j.links || []).forEach(function (l, i) {
      var name = SOURCE_NAMES[l.source] || l.source;
      var b = el("a", i === 0 ? "btn" : "btn alt", i === 0 ? "View posting ↗" : "Also on " + name);
      b.href = l.url;
      b.target = "_blank";
      b.rel = "noopener";
      srcs.appendChild(b);
    });
    card.appendChild(srcs);

    return card;
  }

  function currentFilters() {
    return {
      q: document.getElementById("q").value.trim().toLowerCase(),
      city: document.getElementById("city").value,
      jtype: document.getElementById("jtype").value,
      wmodel: document.getElementById("wmodel").value,
      charityOnly: document.getElementById("charityOnly").checked,
    };
  }

  function applyFilters() {
    var f = currentFilters();
    var list = document.getElementById("list");
    list.innerHTML = "";
    var shown = 0;
    state.jobs.forEach(function (j) {
      if (f.charityOnly && !j.charity) return;
      if (f.city && cityOf(j.location) !== f.city) return;
      if (f.jtype && j.jobType !== f.jtype) return;
      if (f.wmodel && j.workModel !== f.wmodel) return;
      if (f.q) {
        var hay = (j.title + " " + j.employer).toLowerCase();
        if (hay.indexOf(f.q) < 0) return;
      }
      list.appendChild(renderCard(j));
      shown++;
    });
    document.getElementById("empty").hidden = shown > 0;
    document.getElementById("count").textContent =
      shown === state.jobs.length
        ? shown + " current opening" + (shown === 1 ? "" : "s")
        : shown + " of " + state.jobs.length + " openings";
  }

  function fillCityOptions() {
    var sel = document.getElementById("city");
    var cities = {};
    state.jobs.forEach(function (j) {
      var c = cityOf(j.location);
      if (c) cities[c] = true;
    });
    Object.keys(cities).sort().forEach(function (c) {
      var o = document.createElement("option");
      o.value = c;
      o.textContent = c;
      sel.appendChild(o);
    });
  }

  function fmtUpdated(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  }

  ["q", "city", "jtype", "wmodel", "charityOnly"].forEach(function (id) {
    document.getElementById(id).addEventListener("input", applyFilters);
    document.getElementById(id).addEventListener("change", applyFilters);
  });

  fetch("/api/jobs")
    .then(function (r) { return r.json(); })
    .then(function (data) {
      state.jobs = data.jobs || [];
      state.updatedAt = data.updatedAt;
      document.getElementById("meta").textContent =
        "Last updated " + (fmtUpdated(data.updatedAt) || "—") + " · " + (data.count || 0) + " openings";
      fillCityOptions();
      applyFilters();
    })
    .catch(function () {
      document.getElementById("meta").textContent = "Could not load listings right now — please try again later.";
    });
})();
