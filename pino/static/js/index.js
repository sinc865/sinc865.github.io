/* ──────────────────────────────────
   Nerfies テンプレ由来の設定は極力維持
────────────────────────────────── */
window.HELP_IMPROVE_VIDEOJS = false;

const INTERP_BASE = "./static/interpolation/stacked";
const NUM_INTERP_FRAMES = 240;
const interp_images = [];

/* 画像プリロード（元のまま） */
function preloadInterpolationImages() {
  for (let i = 0; i < NUM_INTERP_FRAMES; i++) {
    const path = `${INTERP_BASE}/${String(i).padStart(6, "0")}.jpg`;
    interp_images[i] = new Image();
    interp_images[i].src = path;
  }
}

function setInterpolationImage(i) {
  const image = interp_images[i];
  image.ondragstart = () => false;
  image.oncontextmenu = () => false;
  $("#interpolation-image-wrapper").empty().append(image);
}

/* ──────────────────────────────────
   DOM が揃ってから初期化
────────────────────────────────── */
$(document).ready(function () {

  /* ▼ ナビバー・ハンバーガーメニュー */
  $(".navbar-burger").on("click", () => {
    $(".navbar-burger, .navbar-menu").toggleClass("is-active");
  });

  /* ▼ 研究結果カルーセルの初期化 */
  const carouselEl = document.querySelector("#results-carousel");
  if (carouselEl) {                              // null チェック
    const itemCount = carouselEl.querySelectorAll(".item").length;

    const options = {
      slidesToShow: 1,
      slidesToScroll: 1,
      centerMode: true,        // ← v3 は center ではなく centerMode
      edgePadding: 0,      // ← 左右に “見切れ” を 80px ずつ
      gutter: 20,      // ← スライド同士の隙間を 20px
      loop: itemCount > 1,
      autoplay: false,
      navigation: true,

      /* breakpoints は “配列” で渡す */
      breakpoints: [{
        changePoint: 768,       // 768px 以下
        edgePadding: 0,
        gutter: 20,    
        slidesToShow: 1,
        slidesToScroll: 1,
        centerMode: false
      }]
    };
    

    /* attach は 1 回だけ！ */
    bulmaCarousel.attach(carouselEl, options);
    } else {
      console.warn("#results-carousel が見つかりません");
    }

  /* ▼ 補間スライダー（元コードまま） */
  preloadInterpolationImages();
  $("#interpolation-slider")
    .on("input", e => setInterpolationImage(e.target.value))
    .prop("max", NUM_INTERP_FRAMES - 1);
  setInterpolationImage(0);

  /* ▼ Bulma-Slider（スライダー UI） */
  bulmaSlider.attach();

  /* ▼ Results セクション用カルーセル ---------------------------- */
  const resultsE2 = document.querySelector('#results-carousel-ex');
  if (resultsE2) {
    const n = resultsE2.querySelectorAll('.item').length;

    const resultsOpts = {
      slidesToShow: 1,   // PC は 3 枚
      slidesToScroll: 1,
      centerMode: false,
      gutter: 20,
      loop: n > 1,
      autoplay: false,
      navigation: true,
      breakpoints: [{
        changePoint: 768,             // 768px 以下はスマホ扱い
        slidesToShow: 1,
        slidesToScroll: 1,
        gutter: 10,
        centerMode: false
      }]
    };

    bulmaCarousel.attach(resultsE2, resultsOpts);
  }


});


