async function loadModels() {
	const MODEL_URL = "/models" // 모델 디렉토리 경로
	await faceapi.nets.ssdMobilenetv1.loadFromUri(MODEL_URL)
	await faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL)
	await faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL)
}

// 페이지 로드 시 기본 이미지 설정
window.onload = function () {
	const uploadedImage = document.getElementById("uploadedImage")
	uploadedImage.src = "assets/imgs/male.png"
	uploadedImage.style.display = "block"
}

// 이미지 클릭 시 파일 업로드 트리거
document.getElementById("uploadedImage").addEventListener("click", function () {
	document.getElementById("uploadImage").click()
})

// 이미지 업로드 시 처리
document.getElementById("uploadImage").addEventListener("change", function () {
	const file = this.files[0]
	if (file) {
		const reader = new FileReader()
		reader.onload = async function (e) {
			const uploadedImage = document.getElementById("uploadedImage")
			uploadedImage.src = e.target.result
			uploadedImage.style.display = "block"
			clearResults() // 이미지가 업로드될 때마다 결과 초기화
			await processImage(uploadedImage.src)
		}
		reader.readAsDataURL(file)
	}
})

// 성별 변경 시 기본 이미지 변경
document.querySelectorAll('input[name="gender"]').forEach((element) => {
	element.addEventListener("change", function () {
		const uploadedImage = document.getElementById("uploadedImage")
		if (this.value === "male") {
			uploadedImage.src = "assets/imgs/male.png"
		} else if (this.value === "female") {
			uploadedImage.src = "assets/imgs/female.png"
		}
		uploadedImage.style.display = "block"
	})
})

async function processImage(imageSrc) {
	showLoadingModal()

	await loadModels()
	const uploadedImage = document.getElementById("uploadedImage")
	const uploadedImageDetection = await faceapi.detectSingleFace(uploadedImage).withFaceLandmarks().withFaceDescriptor()

	if (!uploadedImageDetection) {
		alert("사람 얼굴을 포함한 이미지를 선택해주세요.")
		hideLoadingModal()
		return
	}

	const uploadedDescriptor = uploadedImageDetection.descriptor

	const gender = document.querySelector('input[name="gender"]:checked').value
	const targetImages = getTargetImagesForGender(gender)

	for (let i = 0; i < targetImages.length; i++) {
		const target = targetImages[i]
		const targetImage = await fetchImage(target)
		const targetImageDetection = await faceapi.detectSingleFace(targetImage).withFaceLandmarks().withFaceDescriptor()

		if (targetImageDetection) {
			const targetDescriptor = targetImageDetection.descriptor
			const distance = faceapi.euclideanDistance(uploadedDescriptor, targetDescriptor)
			const similarity = Math.max(0, (1 - distance) * 100).toFixed(2)

			const listItem = document.createElement("li")
			listItem.classList.add("resultItem")

			const targetImageElement = document.createElement("img")
			targetImageElement.src = target
			listItem.appendChild(targetImageElement)

			const progressBarContainer = document.createElement("div")
			progressBarContainer.classList.add("progressBarContainer")
			const progressBar = document.createElement("div")
			progressBar.classList.add("progressBar")
			progressBar.style.width = similarity + "%"
			progressBarContainer.appendChild(progressBar)

			const percentageText = document.createElement("span")
			percentageText.textContent = similarity + "%"

			listItem.appendChild(progressBarContainer)
			listItem.appendChild(percentageText)
			document.getElementById("resultsList").appendChild(listItem)
		}

		updateLoadingModal(((i + 1) / targetImages.length) * 100)
	}

	hideLoadingModal()
	document.getElementById("resultsContainer").style.display = "block"
}

async function fetchImage(src) {
	const response = await fetch(src)
	const blob = await response.blob()
	return await faceapi.bufferToImage(blob)
}

function getTargetImagesForGender(gender) {
	if (gender === "male") {
		return [
			"assets/maleKR/2LAp8CxoD3pTIsMttiFdMdk2xFW8leNJOCUpaG_eeXnuQmesQPFR5cZH-GR7WdxES3cYrwTMtcZBE9n9I8Sbr1XrQo85OvMkbOmSQiyhEmqpVYzr84jxwzyg2BnDOAQtw6ACloqZF26XuThs3fai0Q.webp",
			"assets/maleKR/3GK-DtkmjRwE3b8z3Ut-BN5dyd3-ukR5PyzxtdLVDY2q7NrfGRZyWiNpks74fMAqo_RJJIgbyORNslkBP1JavxbnhnyldBBsXS8iGi-1Wr-KEe5mISrUDnfmzLcF3b5SXjdt6fo8CNacrqBiPkF1iQ.webp",
			"assets/maleKR/3n7y5otAxHtbLNt1ktj9MvN41410vOcngd40TbRmILAhtwUASPTfwwZCGyO_GamWjMrsCjOEPt_ROvYLjkd1uo0Gl8r7sI0mlme7wUs1Unm_XoWVkyO-8ZpLTtxm1YOfFJ36yJTYmUCMX79b2Wa3Ng.webp",
			"assets/maleKR/4WT5ZVzp1SJzgxd9ZR19fq9NmoEW5Xkl4CiZhPiYVR-zTKDCogdDuUFXFOh7OFIUUqlGT8fn05sIvb57JaFHWTkciNt8AsUHCfGNYy0PpvZiMtKElielHvYnmKvGd0kd-hHQXRVXT0z7ZZsb0xPi5g.webp",
			"assets/maleKR/6evxzuJ3QJbx3o3rcQgF2BzWexT3uzCa_wkE_pbZSBreSyFqXVZaeP-mhJ3OKYU9MCKbb3H02W1pCEUibWbrsr1MM8dbOMH5MK-eDlJ3YkGH3E0oLQEPRKRK-rczfOsua8jbnrFEBl0-hVebX6BjMA.webp",
			"assets/maleKR/FQRof2nbq8UcIPsmFhtar1or33at2yHg6ufI_tNYeHmgcoouklx31DRBDbKbe7rQKkWdPCoWM4bdTqGdLH3-nGHdUWI46nqLjmC6fZsn_Y4quWV_QXP3AvSY1bNal_7_Ic_rm57URC48rZWQejsm5w.webp",
			"assets/maleKR/GGeRgbfBPv1BB44tcwGAG_YMVplluFjrkOHRoyzisYW0yqRnd8yZtY_lV-99DX6fZPQMy6VkrfsMmYyVAM7jujKf9hTuwH85R3Dxby2RA5TuefZRVdrdQokXm0xxoix62noCiVNxw32ZlGTEy-bQgA.webp",
			"assets/maleKR/HHb4Lao9elKZ85wgAPo3r8dGhy-negIzTACu1OQnypVyTdEqdzPsppv5Wck89qgurklJkZZpnEgHf8Ajaj_-IWdhnQqfDZziycZHFkQ17Q1wmuZQho40A9_7-n25I55eq2aXRZ8t-aDP8Y2f2SUfTQ.webp",
			"assets/maleKR/IBBZ6fICkDcyoBuwOm9DpHUsc51EZGiRk4fybvKkBQeAgoxv9uqwLFni8KgSv14qZiESkKSZADjJDSEGeFg6kNlQcCHT5TrF8-5NK9ggAzMoZyTTp5-wiZdHwpx555W8SJ6_I-e9j7MW0dueOUxpFg.webp",
			"assets/maleKR/Ikoy67HmwECWtGuyyQIoG_NOVa4i38CpO0zg-xADHDP3RsqMPp6B6VpMRInynm3DtF2FUDjtQPEAoiFDgIhEXbJr3Rxozs2YBlRRnksiJ0ObKfZHWjuXmEd84ZbMzfZ7lVbXh5YnO_rk0tf5PX3alg.webp",
			"assets/maleKR/LUGZdI95NNixuecErMKsqdtY3jXSiH22paatCrNuyzw3qj9M74_zyBlsn2rb9snZSGFu6t2jlz_MCp2XdbaNr-2xxQ9AM0n8eNFUZPA9ikU9Y-s26OJnFLQfn1C_joILxIysYt2cootGD-5699dHRQ.webp",
			"assets/maleKR/LgqbxQFrYVgqjEebfbPtbRdw1ot-iCry-eycUUrx1z79RTnQXadb4S_U92WNAulf94MB38J7mrz2IEMs0NWnIf02eFbfb2rpMKCb40qWG5nYFYYdz5TCFFkGRDIN-69NcvJWYH9LHwa1LJnH1HyOdw.webp",
			"assets/maleKR/RRElEWw1OmyUalDofOwHvcF7b_lYehun_csQpc7ftq9HQeMyZt_EIAZRUhWhN6zmosv8IUlUEoRllYDTDf2ji9SCSXsLTOCgr8QnxbDlBgCx6j8-YVvxbKJU2Ur8k_5RSNjFURUfKyQU00tFKKLiOA.webp",
			"assets/maleKR/TYFSKJxFSm0ioUlG8JuTH26ihiR7makI3_3k7F5ZETVV4-4fiXgJkiCdCpTCt1FMj7rc1CCfI0Egt4LKLvHsroWcQQYBnxt34QZtxu1mFlwqNG4zfdppmf-ouAVxUtBxoQOKxBXXJDDA027fUVymzg.webp",
			"assets/maleKR/XA8qqCsrfqeu7bD2Ux_5oe8X0V3FEEzToOZfANAEmloFqHT9apO0jO-GcxGLOxuOX7OiNK4pdlrsnmzQ2a2-E-aZGtRRwhFHehV89fNTD4Tctbb8T0S-4dlFg4n-aOCVzq9m8LqQoGMuS2hZ_Sa0zg.webp",
			"assets/maleKR/XULkzgrTIDp8U1sTlPhYaT5mk1Uxthx4pkFh4XkLkhxDUsJ-c658mxBLB1N6D5P69jAPmgZVQ3VEcnOMCdzDsg_-_lI_uFCHDmPYkoFS5f4dMwqfgSk10SMbDjsGFMMIOlIyjw8b-c1SIXB9bvG2IA.webp",
			"assets/maleKR/XoE5k29pC0a-h6O1jePn--TAAl_IEsNZxTewvqW2SByUll1iJgEHuoaWCrQHP4vm87ya1i9xcDywfgdYUZWtxuk94BYKRhP8vf12hMKSCjMFObLmy2Q1e3ocyNzLXD2ZBiDdUhsBKpV4L_By2pdQnQ.webp",
			"assets/maleKR/Y2a0J1zTE1yzz-IZoT8d7wbs7pLFESInRgK5C1-Ts3qKFbNo3FQf1q9PrgQiQ2cAzXb-alx8tAXUhp8dUCXgd843nLaOx-tUukfXqplG9LOO-b-1P1EKJOdtkWI7NXhmVYwDTQ4MR0s0l2pWqaKjqA.webp",
			"assets/maleKR/ZTY4LjfWfVheqJj1ipuUjw0pzEhuSxU4rQCnLm5W1HS1ted_RSVr3seg4YCzvByLydJVx6sV8796eY_Jk6lIMKEW1VUPd4M27liM_RDkgtqG7O-oyBHBoZqfD9KGin4BCE2ldmO9cQg3RfK6cpBdGg.webp",
			"assets/maleKR/diYaDKwbXK7G-v4dlUkFuFngaLG6b16wCsFIeHageCF2GxMt_thEjqeg3R2UDiTtxLTB9Ihy0SF86fpoV3ejoiUprvnv0tFwTI5ylmJiLiwZK1QwXVl0fOnM0UGbT8kThJUlkyKd24KQo38XTYv-Dw.webp",
			"assets/maleKR/gv__WVMkdXyOiCyWh4BYw24DavFS0F0c3ob5d_Xu1fH5u9JFY1vnin2H-XWEXHqvZtaRv2TFL1Z-YVTmJDG1cdcGRYXKP0A5XUB_SEfWSptpEu7yfWRi90UVWu30CfuFxSWHuMoYvtkajVkCJ4mZ5Q.webp",
			"assets/maleKR/nl6IpEnM1rTpvAoW15cvPpjTKgniULH1S9OyeCrPhWCrcTQa-bIlmGmyg2-v4nyk8eeW0Pb1P8NMxfhpUIq4OtyOhV24BJo_skm1qzjEBsliKGejQbSYgdeLwStYGbZcynkwrVX_Z4fDqFDFEKundQ.webp",
			"assets/maleKR/u-Fbx7fABPavF-9Hx74hoqQdd2QH6Yzi4dlugcya45PVQ7mDa0Wb72N_5X3Rxcj-6KIzkZ2eVA7sngXYrZTkVNiEXQyPmof671RZBDYQkcTVXjYoL-dKpT9rcmRDhY3iUK4NSg9-yFpf8nTpaFZCQA.webp",
			"assets/maleKR/ujq_GL1yzkrCLpjbNWw544xejsYj82Z7GOOW8AErlfl4OfnGlHtSTAbRO2zo9lrD1k75U17TUHkXowlYNkZFxOSQocFwP5ksQeKK-StzPYLhrQEZJYSVkjo_RylrGOCtEpOS-s5OLnkP-WvNr0yDrQ.webp",
			"assets/maleKR/vcdLxb_MDHBBDJIKlJoiL3suz3c5VIuGdYlguWD8Pexumr_4OBu4w41LDdKlPdAM_UK1pwT3pOJrzTMyubckFhFkzrKBVB6O3-rW3HBKOBRU3GjLUdnxMtIOMtznM3cZScLyJb2nz2mvb83njnTUOw.webp",
			"assets/maleKR/wh6zG6dgMKTAv0jUpaeruIHfX2_Q5e5Ljal4emMPk_pfiK6rpXUWSz4IHt7CMrWDzBv-htZXUwaeqUxiEEBfDReZjiDXPaMsAgVEwMCW2WF5hqoHz81C-LHuwRLvknsCamO-w4IB2WrNHJo1SG_8EQ.webp",
			"assets/maleKR/xfT596HJeElTXG_ATTDlQLbhh-5-C8ZYDFvqp-7dw_ZqHDMoVj6FqmNTsS1xsfh6b4BerSbj84oOyo-K1Wy4tx7mBVlHztcqcGPp2yU9V8_eQiHtCo0o_cABf4_IUTyqbZPi0gdQOXFMQgGeOgV-nQ.webp",
			// ... (더 많은 남성 이미지)
		]
	} else {
		return [
			"assets/femaleKR/107748_106566_930.jpg",
			"assets/femaleKR/1642099816533.jpeg",
			"assets/femaleKR/2022111700193_0.jpg",
			"assets/femaleKR/2211241059480190_119_tc.jpg",
			"assets/femaleKR/229008_130396_511.jpg",
			"assets/femaleKR/40963_78843.jpeg",
			"assets/femaleKR/5053_5563_233.jpg",
			"assets/femaleKR/672109_2064_5143.jpg",
			"assets/femaleKR/CX0xZvQraxY0tKM5Qdy8Mfp3BiyjkLUSvOz6f0Xg42eD299eoOTxP4BEvdBT0YV4Md4YN-khdxZbj6BDGM94ABNy0cZklt1Qvzuhf02J6feA6F-Iq1XdD_AqEjsGJaPpLISm56sl_Jr8VAVPJerizw.webp",
			"assets/femaleKR/JH0jd7jiuMEMStIrFgh-E048ki_rBcFY4cCW6zsTxnXu6XvCffbKvjPaU_HlgkCfTx8Se-TRS0YjZdg_8R1ze5GvixL9sBLNq_9piOnXCGLKBzmAMTn_BuimnKXluKO8chWIo1AuFKSRCuSRw2upFQ.webp",
			"assets/femaleKR/K3a6TxMxdt-nLv9JXAZBvNL55_Sh-XEz6TAiveH8kwdJdaeJfrpOnBdXGPA1h4yMuplUgSVf4GQQg80FxOrxJA.webp",
			"assets/femaleKR/PP10081600034.jpeg",
			"assets/femaleKR/SSI_20140817180729_O2.jpg",
			"assets/femaleKR/V1dimmqQ51ymFT6TLC4dWHxr7PPaym48-kofQpdK6SZwSmcccJgPN71r7kDpjMHhA7c9zajWIv5-FPkmWVhzFg.webp",
			"assets/femaleKR/a-CyZb40jxEj6w3smXKgDPi5TASEsEjAyvZ43dLCNohFfvxj9YCOaCabR7h1fvt_g8n2TnUd-XK_Uh769FkqtbcreP-Blu5UhOyFm92URxGMBwIlj5AMrXfPPIFYE8Z6UdWEwfLndvrV2Ojw5kK-hQ.webp",
			"assets/femaleKR/image-6c18e1fa-ebbc-477b-8128-6a623505c790.jpeg",
			"assets/femaleKR/image_readtop_2016_786587_1478839394.jpg",
			"assets/femaleKR/images.jpeg",
			"assets/femaleKR/isp20230112000217.466x551.0.jpeg",
			"assets/femaleKR/isp20230112000218.409x614.0.jpg",
			"assets/femaleKR/news_1718088311_1370607_m_1.jpeg",
			"assets/femaleKR/rg_VWdoKbINZ1kN1DvchSuKznzkDO6qs_80D8TAmmclzKxKmUJNwqOJLQZFlQlJqcTdRDnYRcS24hP_FxzflvXPnm3utrDfV54Icfw2GxKC1X9bUIWMi-jITRe2jHyCY6crfvyFI0QY5Z5Fal33h3Q.webp",
			"assets/femaleKR/tjalswjd191025.jpg",

			// ... (더 많은 여성 이미지)
		]
	}
}

function showLoadingModal() {
	const modal = document.getElementById("loadingModal")
	modal.style.display = "block"
}

function hideLoadingModal() {
	const modal = document.getElementById("loadingModal")
	modal.style.display = "none"
}

function updateLoadingModal(percentage) {
	const progressBarInner = document.getElementById("progressBarInner")
	progressBarInner.style.width = percentage + "%"
	progressBarInner.textContent = Math.round(percentage) + "%"
}

function clearResults() {
	// 결과 리스트 초기화
	document.getElementById("resultsList").innerHTML = ""
}

// 모달 닫기
document.querySelectorAll(".close").forEach((element) => {
	element.addEventListener("click", function () {
		hideLoadingModal()
	})
})
